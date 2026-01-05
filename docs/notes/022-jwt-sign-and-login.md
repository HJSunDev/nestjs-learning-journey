# 022. JWT 认证与 Token 签发 (Sign & Login)

### 1. 主流鉴权方案对比

主流的身份认证方式主要有三种：**Session-Cookie**、**Token (JWT)** 和 **OAuth 2.0**。

#### 1.1 Session-Cookie 认证 (传统王者)

* **机制原理**：
  1. **认证**：用户登录成功后，服务端创建一个 Session 对象（包含用户信息），并生成一个唯一的 `SessionID`。
  2. **存储**：服务端将 Session 存储在内存或数据库（Redis）中；客户端（浏览器）通过 `Set-Cookie` 响应头接收 `SessionID` 并存入 Cookie。
  3. **交互**：后续每次请求，浏览器自动在 Header 中携带 Cookie (含 SessionID)，服务端根据 ID 查找用户信息。
* **优点**：
  * **控制力强**：服务端可以随时销毁 Session（例如强制用户下线、踢人）。
  * **开发成熟**：大多数 Web 框架（Spring Security, Passport 等）默认支持且生态完善。
* **缺点**：
  * **有状态 (Stateful)**：服务端需要存储状态。在分布式/微服务架构下，需要通过 Session 共享（如 Redis）来解决，增加了架构复杂度。
  * **移动端不友好**：原生 App（iOS/Android）没有浏览器的 Cookie 自动管理机制，需要手动处理 Cookie，开发繁琐。
  * **CSRF 风险**：Cookie 容易被跨站请求伪造攻击利用。

#### 1.2 Token (JWT) 认证 (现代主流)

* **机制原理**：
  1. **签发**：用户登录成功后，服务端将用户信息（如 UserID, Role）经过加密/签名生成一个字符串（Token）。
  2. **存储**：服务端**不存储** Token（无状态），客户端收到后自行存储（LocalStorage, SessionStorage 或 SQLite）。
  3. **交互**：后续请求中，客户端手动将 Token 放入 HTTP Header (`Authorization: Bearer <token>`)。服务端仅验证签名是否正确，解码后直接使用。
* **优点**：
  * **无状态 (Stateless)**：服务端不需要查库即可验证身份，天然支持分布式、微服务，负载均衡无压力。
  * **跨平台/跨域**：不依赖 Cookie，完美支持移动端 App、小程序、IoT 设备。
  * **性能**：减少了数据库查询（Payload 自带基本信息）。
* **缺点**：
  * **撤销困难**：Token 一旦签发，在有效期内一直有效。若需中途废弃（如改密码强制下线），需要引入“黑名单”机制（Redis），这会让它变回“有状态”。
  * **流量开销**：JWT 包含了 Payload 信息，Token 字符串通常比 SessionID 长很多，占用带宽。

#### 1.3 OAuth 2.0 (第三方授权)

* **机制原理**：
  * 这是一个**授权标准**而非简单的认证协议。它允许用户授权第三方应用访问其存储在另一服务提供者（如 Google, GitHub, 微信）上的信息，而无需将用户名和密码提供给第三方应用。
  * **流程**：用户跳转至授权服务器 -> 用户同意授权 -> 授权服务器返回 Authorization Code -> 客户端用 Code 换取 Access Token。
* **适用场景**：
  * **社交登录**：使用微信、QQ、GitHub 账号登录。
  * **开放平台**：开发第三方应用调用平台 API。

| 方案              | 状态管理              | 客户端存储        | 撤销能力      | 分布式支持      | 移动端支持               |
| :---------------- | :-------------------- | :---------------- | :------------ | :-------------- | :----------------------- |
| **Session** | 服务端 (Redis/Memory) | Cookie            | 强 (随时删)   | 弱 (需共享存储) | 弱 (需手动做 Cookie Jar) |
| **JWT**     | 无 (客户端自持)       | LocalStorage / DB | 弱 (需黑名单) | 强 (天生支持)   | **强** (API 友好)  |
| **OAuth2**  | 授权服务器管理        | Token             | 强 (可吊销)   | 强              | 强                       |

### 2. 移动端鉴权的最佳实践

移动端应用（iOS/Android/小程序）与传统浏览器环境有显著差异：

* **无 Cookie 环境**：原生 App 的网络库（如 URLSession, OkHttp）默认不自动管理 Cookie，手动处理 SessionID 繁琐。
* **长连接与弱网**：移动端常需保持长登录状态（RefreshToken 机制）。
* **多端同步**：同一账号可能在多台设备同时登录。

**结论**：**JWT (JSON Web Token)** 是移动端开发的首选。它不依赖 Cookie 容器，通过 HTTP Header (`Authorization: Bearer <token>`) 传输，完美契合移动端的 API 调用习惯。

### 3. JWT 核心概念解构

JWT 本质上是一个经过签名、Base64Url 编码的 JSON 字符串，由三部分组成，中间用 `.` 分隔：`Header.Payload.Signature`。

1. **Header (头部)**: 描述元数据，如算法 (`alg`: HS256) 和类型 (`typ`: JWT)。
2. **Payload (载荷)**: 存放有效信息（Claims）。
   * **标准字段**: `exp` (过期时间), `sub` (主题), `iss` (签发人)。
   * **自定义字段**: 如 `userId`, `role`, `mobile`。**注意：不要存放敏感数据（如密码），因为 Payload 仅是编码并未加密，可被解码查看。**
3. **Signature (签名)**: 用于验证消息未被篡改。
   * 公式：`HMACSHA256(base64UrlEncode(header) + "." + base64UrlEncode(payload), secret)`
   * 服务器持有 `secret` 密钥，只要签名校验通过，即可信任 Payload 中的数据。

### 4. NestJS 中的 JWT 实践架构

NestJS 结合 `Passport` 生态提供了优雅的认证实现：

* **@nestjs/jwt**: 封装了 `jsonwebtoken` 库，提供 Token 的签发 (`sign`) 和验证 (`verify`) 服务。
* **Passport**: Node.js 最流行的认证中间件，通过“策略模式”支持多种认证方式。
* **Passport-JWT**: 专门处理 JWT 提取和校验的策略。

**工作流**：

1. 用户登录 -> AuthService 校验密码 -> JwtService 签发 Token (Sign)。
2. 用户请求 -> Guard 拦截 -> JWT Strategy 解析 Header -> 校验签名 -> 还原 User 对象注入 Request。

### 5. 深度解析 `JwtModule.registerAsync`

在 `AuthModule` 中，我们使用了 `registerAsync`，这涉及到 NestJS 动态模块的高级用法。

#### 5.1 `register` vs `registerAsync`

* **register**: 同步配置。配置项必须是静态常量。
* **registerAsync**: 异步配置。当配置项依赖其他模块（如 `ConfigService` 读取环境变量）或需要异步获取时使用。它允许通过 `useFactory` 注入依赖。

#### 5.2 `forRoot` vs `register`

这是一种**约定俗成**的命名规范（非强制，但官方模块都遵守）：

* **`forRoot / forRootAsync`**: 用于**全局**配置，通常只在 `AppModule` 中调用一次。产生的模块通常是全局单例（Global）。例如：`TypeOrmModule`, `ConfigModule`。
* **`register / registerAsync`**: 用于**特定功能**配置。每次导入时可能需要不同的配置，或者该模块是为特定特性服务的（非全应用通用）。例如：`JwtModule`（可能不同模块用不同的 Secret），`MulterModule`。

**为什么在这里用 `registerAsync`？**
因为我们需要从 `ConfigService` 获取 `JWT_SECRET`。如果在 `AuthModule` 初始化时 `ConfigModule` 还没加载完，或者直接读取 `process.env`（不推荐，无类型安全），都会有问题。`useFactory` 确保了在 ConfigService 准备好后，才创建 JwtService。

---

## 🛠️ 行动指南：快速开始

### 1. 依赖安装

```bash
npm i @nestjs/jwt @nestjs/passport passport passport-jwt @types/passport-jwt
```

**依赖详解与必要性检查**：

* **`@nestjs/jwt` (核心)**:
  * **作用**: NestJS 官方封装的 JWT 操作库。
  * **体现**: 在 `AuthModule` 中注册，在 `AuthService` 中注入 `JwtService` 用于调用 `.sign()` 方法生成 Token。
* **`@nestjs/passport` & `passport` (架构基础)**:
  * **作用**: NestJS 的标准认证中间件封装。提供了统一的认证接口（Guard, Strategy）
  * **体现**: 为下一章“全局守卫校验”做准备，届时将使用 `AuthGuard` 进行路由保护。
* **`passport-jwt` (验证策略)**:
  * **作用**: Passport 的 JWT 插件，专门负责从请求头提取 Token、验证签名并解析 Payload。
  * **体现**: 将在下一章编写 `JwtStrategy` 时使用，用于实现“验签”逻辑。
* **`@types/passport-jwt`**: TS 类型定义。

### 2. 环境变量配置

**步骤 2.1**: 修改 `.env` (生产环境) 和 `env.ai` (开发模板)。

```properties
# === JWT 配置 ===
JWT_SECRET=YourSuperSecretKeyHere_NeverShareIt
JWT_EXPIRES_IN=1d
```

**步骤 2.2**: 在 `src/common/configs/app-config.module.ts` 中添加 Joi 校验。

```typescript
// 在 validationSchema 中添加
JWT_SECRET: Joi.string().required(),
JWT_EXPIRES_IN: Joi.string().default('1d'),

// 在 load 函数中添加结构化返回
jwt: {
  secret: process.env.JWT_SECRET,
  expiresIn: process.env.JWT_EXPIRES_IN || '1d',
},
```

### 3. 数据层改造 (User)

**步骤 3.1**: 修改实体 `src/user/entities/user.mongo.entity.ts`，支持手机号。

```typescript
@Entity('users')
export class User extends CommonMongoEntity {
  @Column()
  name: string;

  // 允许邮箱为空 (适配手机号注册)
  @Column({ nullable: true })
  email?: string;

  @Column({ nullable: true })
  phoneNumber?: string;

  @Column()
  password: string;
  // ...
}
```

**步骤 3.2**: 更新 `UserService` (`src/user/user.service.ts`)，添加查找方法。

```typescript
// 必须确保 UserModule 导出了 UserService，否则 AuthModule 无法注入
async findByPhoneNumber(phoneNumber: string): Promise<User | null> {
  return this.userRepository.findOneBy({ phoneNumber });
}
```

**步骤 3.3**: 确保 `UserModule` 导出服务。

```typescript
// src/user/user.module.ts
@Module({
  // ...
  exports: [UserService], // 关键！
})
export class UserModule {}
```

### 4. 认证模块实现 (Auth)

**步骤 4.1**: 创建 DTO (`src/auth/dto/auth.dto.ts`)。

```typescript
// 仅展示核心字段，省略 Import
export class LoginDTO {
  @Matches(regMobileCN)
  @IsNotEmpty()
  readonly phoneNumber: string;

  @IsNotEmpty()
  readonly password: string;
}

export class RegisterDTO {
  @Matches(regMobileCN)
  readonly phoneNumber: string;
  
  @IsNotEmpty()
  readonly name: string;

  @IsNotEmpty()
  readonly password: string;

  @IsNotEmpty()
  readonly passwordRepeat: string;
}
```

**步骤 4.2**: 配置 Module (`src/auth/auth.module.ts`)。

```typescript
@Module({
  imports: [
    UserModule,    // 导入 UserModule 以使用 UserService
    HashingModule, // 导入 HashingModule 处理密码
    // 异步注册 JWT 模块
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.secret'),
        signOptions: { 
            expiresIn: configService.get('jwt.expiresIn') 
        },
      }),
    }),
  ],
  providers: [AuthService],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
```

**步骤 4.3**: 实现业务逻辑 (`src/auth/auth.service.ts`)。

```typescript
@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly hashingService: HashingService,
  ) {}

  async register(dto: RegisterDTO) {
    // 1. 校验手机号
    if (await this.userService.findByPhoneNumber(dto.phoneNumber)) {
      throw new BadRequestException('该手机号已注册');
    }
    // 2. 创建用户
    const newUser = await this.userService.create({ ... });
    // 3. 签发 Token
    return this.createToken(newUser);
  }

  async login(dto: LoginDTO) {
    // 1. 查询用户
    const user = await this.userService.findByPhoneNumber(dto.phoneNumber);
    if (!user) throw new UnauthorizedException('账号或密码错误');
  
    // 2. 校验密码
    if (!await this.hashingService.compare(dto.password, user.password)) {
      throw new UnauthorizedException('账号或密码错误');
    }

    // 3. 签发 Token
    return this.createToken(user);
  }

  private createToken(user: any) {
    const payload = { id: user._id.toString(), mobile: user.phoneNumber };
    return {
      access_token: this.jwtService.sign(payload),
    };
  }
}
```

**步骤 4.4**: 暴露接口 (`src/auth/auth.controller.ts`)。

```typescript
@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body() dto: RegisterDTO) {
    return this.authService.register(dto);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDTO) {
    return this.authService.login(dto);
  }
}
```
