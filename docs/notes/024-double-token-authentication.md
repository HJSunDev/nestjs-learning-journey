# 024. 双 Token 鉴权机制 (Access + Refresh Token)

## 1. 核心问题与概念

### 解决什么问题？

在单 Token (JWT) 模式下，我们面临一个两难的**安全与体验悖论**：

* **有效期设短了 (如 15min)**: 安全性高，但用户每隔15min就得重新登录，体验极差。
* **有效期设长了 (如 7天)**: 体验好，但 Token 一旦泄露，黑客有整整 7 天时间为所欲为，服务端难以撤销（无状态特性）。

### 核心概念

我们引入 **双 Token 机制** 解决这个问题：

1. **Access Token (短令牌)**:

   * **有效期**: 极短 (如 15分钟)。
   * **作用**: 请求业务接口 (如获取用户资料)。
   * **特点**: **无状态**，过期即废。就算被劫持，攻击窗口期也很短。
2. **Refresh Token (长令牌)**:

   * **有效期**: 较长 (如 7天)。
   * **作用**: **仅用于**在 Access Token 过期后，换取新的一对 Token。
   * **特点**: **有状态** (存入数据库)。因为需要查库验证，所以服务端拥有了**随时撤销**用户登录态的能力 (如修改密码、强制下线)。
3. **令牌轮换 (Token Rotation)**:

   * 每次刷新时，不仅发放新的 Access Token，**连 Refresh Token 也一起换新**。
   * **优势**: 即使 Refresh Token 泄露，在Access Token过期后，Refresh Token旧令牌即刻失效，最大限度遏制攻击。

---

## 2. 核心用法 / 方案设计 (Usage / Design)

### 场景 A: 登录成功 (Login)

服务端不再只返回一个字符串，而是返回一对令牌。

```json
// POST /auth/login 响应
{
  "access_token": "eyJhb... (15分钟后过期)",
  "refresh_token": "def50... (7天后过期)"
}
```

### 场景 B: 业务请求与自动刷新 (Auto Refresh)

这是一个前端配合的流程，但服务端需要提供支持。

1. 前端用 `access_token` 请求 `/users/profile`。
2. Token 过期，服务端返回 **401 Unauthorized**。
3. 前端捕获 401，拦截请求。
4. 前端用 `refresh_token` 请求 `/auth/refresh`。
5. 服务端验证通过，返回**新的一对** Token。
6. 前端更新本地存储，并重试步骤 1 的请求。
7. 用户全程**无感知**。

---

## 3. 深度原理与机制 (Under the Hood)

### 3.1. 数据库层设计

我们在 `User` 实体中增加了一个字段 `currentHashedRefreshToken`。

* **Hash存储**: 数据库不存 Refresh Token 明文，只存 Hash 值（类似密码）。即使数据库泄露，黑客也拿不到能用的 Token。
* **单点/多点登录**: 本例使用单字段，意味着新设备登录会覆盖旧值（踢下线模式）。若需多端同时在线，可改为数组存储。

### 3.2. 策略分离 (Strategy Separation)

我们使用了两个 Passport 策略：

* **jwt (默认)**: 验证 Access Token。`validate` 仅返回用户信息，不查库，保持高性能。
* **jwt-refresh**: 验证 Refresh Token。
  * **关键逻辑**: 这里**必须**查库。
  * `validate` 流程：解码 Token -> 获取 userId -> 查库取出 hash -> 对比请求中的 Token 和库里的 Hash 是否匹配 -> 匹配则通过。

### 3.3. NestJS Passport 鉴权架构解析

本节深度拆解 `JwtModule`、`Strategy` 与 `Guard` 的协作机制:

#### A. 职责分离：生成者 vs 验证者

* **JwtModule (生成者)**:

  * **角色**: 纯粹的工具包 (Utility)，主要提供 `JwtService` 这个类
  * **职责**: 提供 `JwtService`，只负责把数据加密成字符串，完全不参与 HTTP 请求的拦截。
    * **Sign (签发)**: 在 `AuthService` 中注入 `JwtService` 并调用 `signAsync` 时，会用注册时配置的 `secret` 去生成字符串。
    * **Verify (验证)**: 也提供了 `verifyAsync` 方法。
  * **注入位置**: `AuthService`。
* **PassportStrategy (验证者)**:

  * **角色**: 插件/中间件 ,**不依赖** `JwtModule`
  * **职责**: **验证 (Verify)** Token。它依赖 `passport-jwt` 库，从请求头提取 Token 并解码。它与 `JwtModule` 唯一的联系是它们通常共用同一个 Secret。
  * **注册位置**: `AuthModule` 的 `providers`。

#### 总结：

* `JwtModule` 是给 `AuthService` 用的，用来**生成** Token。
* `Strategy` 是给 `Passport` 用的，用来**验证** Token。
* **它们唯一的交集**：通常它们配置了**相同的 Secret**（密钥）。

#### B. 隐式绑定：Guard 与 Strategy的联系

字符串参数 `'jwt-refresh'` 是**连接 Guard 和 Strategy 的唯一桥梁**。

##### 1. AuthGuard('xxx') 的参数是做什么的？

* 策略 （发送端） 在 `jwt-refresh.strategy.ts` 中：

  ```typescript
  export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh'){ // <--- 这里定义了名字！
      //...
  } 
  ```

  Passport 框架会在启动时，把这个 Strategy 注册到一个全局的 Map 里，Key 就是 `'jwt-refresh'`。
* 守卫（接收端） 在jwt-refresh.guard中：

  ```
  import { Injectable } from '@nestjs/common';
  import { AuthGuard } from '@nestjs/passport';

  /**
   * Refresh Token 专用守卫
   * 绑定 'jwt-refresh' 策略，用于保护 /auth/refresh 端点
   */
  @Injectable()
  export class JwtRefreshGuard extends AuthGuard('jwt-refresh') {} // <--- 这里使用了名字！
  ```
* 这个 Guard 在执行 `canActivate` 时，会去全局 Map 里找名字叫 `'jwt-refresh'` 的策略，然后**自动执行**那个策略的 `validate` 方法。

##### 2. 为什么 Guard 里面没有逻辑？

因为逻辑被**封装**在父类 `AuthGuard` 里了。
`AuthGuard` 的默认行为（伪代码）：

```typescript
// NestJS 源码简化版
class AuthGuard {
  canActivate(context) {
    // 1. 找到当前 Guard 绑定的 Strategy (比如 'jwt-refresh')
    const strategy = findStrategy(this.name);
  
    // 2. 自动从请求中提取 Token (根据 Strategy 的配置)
    // 3. 自动验证 Token 签名 (根据 Strategy 的配置)
    // 4. 自动调用 Strategy.validate() 方法
    const user = strategy.validate(...);
  
    // 5. 如果验证通过，把 user 挂载到 req.user
    request.user = user;
    return true;
  }
}
```

这就是为什么 `JwtRefreshGuard` 不需要写代码。只要继承了 `AuthGuard('jwt-refresh')`，它就自动拥有了上述整套流程。

---

#### C. 请求是如何流转的:

##### 场景：用户发起 GET /auth/refresh

1. **请求到达**: 带着 `Authorization: Bearer <refresh_token>`。
2. **守卫拦截 (JwtRefreshGuard)**:
   * 路由上挂了 `@UseGuards(JwtRefreshGuard)`。
   * Guard 启动，发现自己绑定了 `'jwt-refresh'`。
3. **策略接管 (JwtRefreshStrategy)**:
   * Guard 召唤出名为 `'jwt-refresh'` 的策略。
   * 策略根据配置 `ExtractJwt.fromAuthHeader...` 自动提取 Token。
   * 策略使用配置的 `secret` 验证签名。
   * **签名通过** -> 调用你写的 `validate()` 方法。
   * **签名失败** -> 策略直接抛出 401 异常，请求结束。
4. **业务逻辑 (validate)**:
   * 你写的 `validate` 逻辑执行（检查 payload，返回 user 对象）。
5. **挂载用户**:
   * Guard 将 `validate` 的返回值赋值给 `req.user`。
6. **进入 Controller**:
   * `AuthController.refresh` 被调用。
   * 此时 `req.user` 里已经有数据了。
7. **服务处理 (AuthService)**:
   * `refreshTokens` 方法被调用。
   * 需要**生成**新 Token，此时轮到 `JwtService` 出场。
   * `JwtService` 用配置的 Secret 签发新字符串。

---

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

* ✅ **最佳实践**: 始终使用 **HTTPS**，防止 Token 在传输层被嗅探。
* ✅ **最佳实践**: Refresh Token 最好存储在 **HttpOnly Cookie** 中（防止 XSS）。*注：本教程为了降低调试难度，暂且放在 Body 中返回。*
* ❌ **避免做法**: 永远不要用 Access Token 去换 Access Token（那样就是无限续杯，完全失去了过期的意义）。必须用 Refresh Token 去换。
* ❌ **避免做法**: 登出时只在前端删除 Token。**必须**调用 `/auth/logout` 接口清除服务端数据库里的 Hash，彻底终结会话。

---

## 5. 行动导向 (Action Guide)

本指南假定你已经有一个基础的单 Token 鉴权系统。我们将按依赖顺序进行重构。

### Step 1: 基础设施改造 (Config & Entity)

**这一步在干什么**: 配置两套密钥，并在数据库预留 Refresh Token 的存储位。

**1. 修改 `src/common/configs/app-config.module.ts`**

```typescript
// 在 Joi 校验中增加
JWT_ACCESS_SECRET: Joi.string().required(),
JWT_ACCESS_EXPIRES_IN: Joi.string().default('15m'),
JWT_REFRESH_SECRET: Joi.string().required(),
JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),

// 在 load 配置对象中增加
jwt: {
  accessSecret: process.env.JWT_ACCESS_SECRET,
  accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  refreshSecret: process.env.JWT_REFRESH_SECRET,
  refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
},
```

**2. 修改 `src/user/entities/user.mongo.entity.ts`**

```typescript
@Column({ nullable: true })
currentHashedRefreshToken?: string;
```

---

### Step 2: 扩展 User Service

**这一步在干什么**: 提供对 Refresh Token 字段的读写能力。`AuthService` 需要这些方法来验证和更新 Token。

**修改 `src/user/user.service.ts`**

```typescript
// 1. 更新 Refresh Token 哈希 (用于登录/刷新/登出)
async updateRefreshToken(userId: string, hashedRefreshToken: string | null): Promise<void> {
  await this.userRepository.update(userId, {
    currentHashedRefreshToken: hashedRefreshToken ?? '',
  });
}

// 2. 带哈希查询用户 (用于刷新校验)
async findOneWithRefreshToken(id: string): Promise<User | null> {
  return this.userRepository.findOne({
    where: { _id: new ObjectId(id) },
    select: ['_id', 'name', 'phoneNumber', 'currentHashedRefreshToken'], // 显式选择 select: false 的字段
  });
}
```

---

### Step 3: 实现 Refresh Token 策略

**这一步在干什么**: 创建专门用于验证 Refresh Token 的策略。

**新建 `src/auth/strategies/jwt-refresh.strategy.ts`**

```typescript
import { Injectable, UnauthorizedException } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';

/**
 * Refresh Token 验证策略
 * 从请求中提取原始 Token 并附加到 payload，供 Service 层校验数据库哈希
 */
@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {

  constructor(private readonly configService: ConfigService) {
    super({
      // 从请求头 Authorization: Bearer <token> 中提取 Refresh Token
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // 使用 Refresh Token 专用密钥
      secretOrKey: configService.get<string>('jwt.refreshSecret')!,
      // 是否忽略过期检查 (false = 不忽略，过期会报错)
      ignoreExpiration: false,
      // 将 Request 对象传递给 validate 方法，以便提取原始 Refresh Token
      passReqToCallback: true,
    });
  }

  /**
   * Token 签名验证通过后调用
   * @param req Express Request 对象, 用于提取原始完整 Refresh Token
   * @param payload 解码后的 Refresh Token 内容
   * @returns 附加了原始 refreshToken 的用户信息，挂载到 req.user
   */
  async validate(req: Request, payload: any) {
    // 从 Header 中提取原始的 Refresh Token（未解码的完整字符串）
    const refreshToken = req.get('Authorization')?.replace('Bearer ', '').trim();

    // 如果提取不到 Refresh Token，抛出 401 错误
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh Token 缺失');
    }

    // 返回值会被挂载到 req.user
    // 原始 Refresh Token 用于在 Service 层与数据库中的哈希值进行比对
    return {
      id: payload.id,
      mobile: payload.mobile,
      refreshToken,
    };
  }
}


```

**新建 `src/auth/guards/jwt-refresh.guard.ts`**

```typescript
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Refresh Token 专用守卫
 * 绑定 'jwt-refresh' 策略
 */
@Injectable()
export class JwtRefreshGuard extends AuthGuard('jwt-refresh') {}


```

---

### Step 4: 重构 Auth Service (核心逻辑)

**这一步在干什么**: 实现 Token 轮换逻辑。注意 `getTokens` 中 Access 和 Refresh Token 使用不同的配置。

**修改 `src/auth/auth.service.ts`**

```typescript
// 1. 私有方法：生成双 Token
private async getTokens(userId: string, mobile: string | undefined) {
  const payload = { sub: userId, id: userId, mobile };
  const [at, rt] = await Promise.all([
    // Access Token: 使用默认配置
    this.jwtService.signAsync(payload),
    // Refresh Token: 使用独立 Secret
    this.jwtService.signAsync(payload, {
      secret: this.configService.get('jwt.refreshSecret'),
      expiresIn: this.configService.get('jwt.refreshExpiresIn'),
    }),
  ]);
  return { access_token: at, refresh_token: rt };
}

// 2. 刷新 Token (核心安全逻辑)
async refreshTokens(userId: string, rt: string) {
  const user = await this.userService.findOneWithRefreshToken(userId);
  if (!user || !user.currentHashedRefreshToken) 
    throw new ForbiddenException('Access Denied');

  // 对比 Hash
  const isMatch = await this.hashingService.compare(rt, user.currentHashedRefreshToken);
  if (!isMatch) throw new ForbiddenException('Invalid Refresh Token');

  // 轮换：生成新 Token 并更新数据库
  const tokens = await this.getTokens(user.id, user.phoneNumber);
  await this.updateRefreshTokenHash(user.id, tokens.refresh_token);
  return tokens;
}

// 3. 登出
async logout(userId: string) {
  await this.userService.updateRefreshToken(userId, null);
}

// 4. 辅助方法：存 Hash
private async updateRefreshTokenHash(userId: string, rt: string) {
  const hash = await this.hashingService.hash(rt);
  await this.userService.updateRefreshToken(userId, hash);
}
```

*(注：请同步更新 login 和 register 方法，调用 getTokens 并存储 Hash)*

---

### Step 5: 注册模块与策略

**这一步在干什么**: 将新策略注册到 NestJS 容器，并配置 `JwtModule` 的默认行为（Access Token）。

**修改 `src/auth/auth.module.ts`**

```typescript
@Module({
  imports: [
    // JwtModule 默认配置服务于 Access Token
    // Refresh Token 的签名在 AuthService 中手动指定 secret
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.accessSecret'),
        signOptions: { 
          // ConfigService 返回 string，需要断言以匹配 JwtModuleOptions 类型
          expiresIn: configService.get('jwt.accessExpiresIn') ?? '15m',
        },
      }),
    }),
  ],
  providers: [
    AuthService, 
    JwtStrategy,        // Access Token 策略
    JwtRefreshStrategy, // Refresh Token 策略
    {
      provide: APP_GUARD, // 注册全局 Guard
      useClass: JwtAuthGuard,
    }
  ],
  // ...
})
export class AuthModule {}
```

---

### Step 6: 暴露 API 接口

**这一步在干什么**: 新增 `/refresh` 和 `/logout` 端点。

**修改 `src/auth/auth.controller.ts`**

```typescript
  /**
   * 使用 Refresh Token 换取新的 Access Token
   * 前端在 Access Token 过期(401)后调用此接口实现无感刷新
   */
  @Public() // 绕过全局 JwtAuthGuard，由 JwtRefreshGuard 单独保护
  @UseGuards(JwtRefreshGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '刷新 Token' })
  @ApiResponse({ status: 200, type: TokensDto, description: '刷新成功，返回新的双 Token' })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Request() req: any): Promise<TokensDto> {
    // req.user 由 JwtRefreshStrategy.validate 返回，包含 id 和 refreshToken
    return this.authService.refreshTokens(req.user.id, req.user.refreshToken);
  }

  /**
   * 用户登出
   * 清除服务端存储的 Refresh Token 哈希，使其无法再用于刷新
   */
  @ApiBearerAuth()
  @ApiOperation({ summary: '用户登出' })
  @ApiResponse({ status: 200, description: '登出成功' })
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Request() req: any): Promise<{ message: string }> {
    await this.authService.logout(req.user.id);
    return { message: '登出成功' };
  }
```
