# 023. 全局守卫与 Token 校验 (Global Guard & JWT Strategy)

## 1. 核心概念与原理 (Core Concepts)

### 1.1 守卫 (Guard) 的定义与职责

**技术定义**
Guard 是一个使用 `@Injectable()` 装饰器注解的类。为了被 NestJS 识别为守卫，它**必须**实现 `CanActivate` 接口。

**CanActivate 接口详解**
这是 Guard 的核心契约，它强制类实现一个名为 `canActivate` 的方法：
```typescript
canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean>;
```
- **入参 (context)**: `ExecutionContext` 继承自 `ArgumentsHost`，它封装了当前的执行上下文。在 HTTP 场景下，可以通过 `context.switchToHttp().getRequest()` 获取到原始的请求对象 (`Request`)，从而读取 Headers、Body 或 IP 地址。
- **返回值**: 必须返回一个布尔值（支持 Promise 或 Observable 异步返回）。
  - `true`: **放行**。请求允许进入下一个生命周期阶段（Interceptor/Pipe）。
  - `false`: **拦截**。NestJS 将立即终止请求处理，并自动抛出 `ForbiddenException` (HTTP 403)。

**核心职责：授权 (Authorization)**
Guard 专注于解决 **"该请求是否有权限执行此操作"** 的问题。它在运行时根据特定的逻辑（如 Token 校验、RBAC 角色检查）返回上述的布尔值结果。

**执行时序**
Middleware -> **Guards** -> Interceptors -> Pipes -> Controller

### 1.2 守卫的两种形态与使用场景

NestJS 提供了灵活的绑定机制，守卫既可以是局部的，也可以是全局的。

#### A. 局部守卫 (Scoped Guard)

**使用方式**：使用 `@UseGuards()` 装饰器绑定到特定的 Controller 或 Method 上。

```typescript
// 示例场景：只有管理员模块需要特殊的角色检查
@Controller('admin')
@UseGuards(RolesGuard) // <--- 仅对该 Controller 下的路由生效
export class AdminController { ... }
```

#### B. 全局守卫 (Global Guard)

**使用方式**：通过 DI 容器（在 Module 中提供 `APP_GUARD`）或 `app.useGlobalGuards()` 注册。

```typescript
// 示例场景：全站绝大多数接口都需要 JWT 登录校验
@Module({
  providers: [
    {
      provide: APP_GUARD, // <--- 注册为全局守卫，对整个应用生效
      useClass: JwtAuthGuard,
    },
  ],
})
export class AuthModule {}
```

### 1.3 深入解析：全局守卫的注册位置与作用域

**疑问：在 AuthModule 中注册的 APP_GUARD，为什么能管到 UserModule？**

这源于 NestJS 独特的**模块解析与依赖注入机制**：

1. **单例依赖树 (Singleton Dependency Tree)**:
   NestJS 的应用上下文 (Application Context) 是一棵巨大的依赖树。虽然代码被组织在不同的 Module 中，但最终它们会被解析并合并到一个全局的运行时环境中。
2. **APP_GUARD 的特殊性**:
   `APP_GUARD` 是 NestJS 核心提供的一个**常量 Token**。
   当 NestJS 启动并扫描依赖树时，一旦发现某个 Provider 使用了 `APP_GUARD` 作为 Token（无论这个 Provider 定义在 AuthModule 还是 CoreModule），框架就会自动执行以下操作：
   * 实例化该 Guard 类。
   * **将其挂载到全局请求管道的守卫层级中**。
3. **内聚性原则 (Cohesion)**:
   既然在哪里注册都生效，**为什么我们选择放在 `AuthModule`？**
   * 因为 `JwtAuthGuard` 强依赖于 `AuthModule` 中的 `JwtStrategy` 和配置。
   * 将其定义在 `AuthModule` 中，符合**高内聚**的设计原则——"认证相关的逻辑都呆在认证模块里"。只要 `AppModule` 导入了 `AuthModule`，这个全局机制就会自动生效。

### 1.4 鉴权策略设计：为什么选择全局守卫？

**决策背景：认证 (Authentication) vs 鉴权 (Authorization)**

* **Authentication (你是谁?)**: 这是一个**通用性极高**的需求。在现代 Web 系统中，95% 的接口都需要确认用户身份（Token 校验）。
* **Authorization (你能干什么?)**: 这是一个**业务相关性强**的需求。只有部分接口（如删除用户）需要管理员权限。

**本项目的策略选择**：

1. **针对身份认证 (Token)** -> 采用 **全局守卫 (Global Guard)**。
   * **理由**：默认拒绝所有匿名访问 (Secure by Default)。相比于在 100 个接口上加锁，只在 2 个接口（登录/注册）上解锁（`@Public`）更安全且维护成本更低。
2. **针对角色权限 (Role)** -> 采用 **局部守卫 (Scoped Guard)**。
   * **理由**：并非所有接口都需要管理员权限。在需要的接口上按需添加 `@UseGuards(RolesGuard)` 是更合理的选择。

### 1.5 Passport 适配器与策略模式 (运行机制)

NestJS 的 `AuthGuard` 是对 Node.js 社区标准认证库 `Passport` 的封装。

- **工厂模式**: `AuthGuard('jwt')` 动态生成一个配置好的类。
- **策略模式**: `passport-jwt` 负责具体的 Token 提取与验签。
- **执行链路**: Guard 触发 -> Passport 验证 -> Strategy 验签 -> `validate()` 回调 -> `req.user` 注入。

### 1.6 元数据反射 (Metadata Reflection)

实现 `@Public()` 豁免机制的核心技术是 NestJS 提供的反射服务。

1.  **Reflector (反射服务)**
    *   **技术定义**: `Reflector` 是 `@nestjs/core` 导出的一个 Provider。它封装了底层的 `reflect-metadata` 库，提供了统一的 API 来在运行时 (Runtime) 获取类或方法上的元数据。
    *   **工作机制**: 当我们在代码中使用装饰器（如 `@Public()`）时，本质上是将数据写入到了目标对象的 `metadata` 属性中。`Reflector` 的作用就是在 Guard 执行时，从当前的执行上下文 (`ExecutionContext`) 中把这些数据读取出来。

2.  **getAllAndOverride (层级覆盖读取)**
    *   **设计目的**: 解决装饰器作用域冲突的问题。在 NestJS 中，装饰器可以同时作用于 **控制器类 (Class)** 和 **路由方法 (Handler)**。
    *   **运行逻辑**: 该方法接收两个参数：元数据 Key (`IS_PUBLIC_KEY`) 和一组待扫描的目标对象 (`[Handler, Class]`)。它会按照数组顺序依次检查：
        1.  **优先检查 Handler**: 如果方法上定义了元数据，直接返回该值（忽略类上的定义）。
        2.  **其次检查 Class**: 如果方法上没有，则回退检查控制器类。
    *   **应用结果**: 这种机制实现了 **"方法级配置覆盖类级配置"** 的策略，允许我们在全局/类级策略的基础上，对特定路由进行微调。

---

## 2. 行动指南 (Action Guide)

> 前置说明：相关依赖（如 `@nestjs/passport`）已在上一章 [022. JWT 认证与 Token 签发](022-jwt-sign-and-login.md) 中安装完毕，本章直接开始代码实现。

### Step 1: 定义 JWT 策略 (Strategy)

**这一步在干什么**: 告诉系统如何解析 Token，以及解析成功后如何处理数据。

```typescript
// src/auth/strategies/jwt.strategy.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  
  constructor(private readonly configService: ConfigService) {
    super({
      // 从请求头 Authorization: Bearer <token> 中提取 JWT
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // 验证 token 签名的密钥 使用非空断言 !
      secretOrKey: configService.get<string>('jwt.secret')!,
      // 是否忽略过期检查 (false = 不忽略，过期会报错)
      ignoreExpiration: false, 
    });
  }

  // validate 方法在 token 验证通过后自动调用
  // payload 是解码后的 token 内容
  async validate(payload: any) {
    // 返回值会被自动挂载到 req.user
    return {
      id: payload.id,
      mobile: payload.mobile
    };
  }
}
```

### Step 2: 定义公开装饰器 (Decorator)

**这一步在干什么**: 创建一个标记工具（打标签）。**注意：装饰器本身只负责写入元数据，不包含业务逻辑。识别并处理这个标签的逻辑将在下一步的 Guard 中实现。**

```typescript
// src/common/decorators/public.decorator.ts
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

### Step 3: 实现全局守卫 (Guard)

**这一步在干什么**: 实现全局守卫。**关键点：我们需要重写 `canActivate` 方法，在这里通过 `Reflector` 读取 `@Public` 标记，手动编写"放行"逻辑。**

```typescript
// src/common/guards/jwt-auth.guard.ts
import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {

  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    // 1. 手动读取目标方法或类上的元数据 (这正是我们自定义的逻辑)
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // 2. 如果标记为 Public，直接放行 (跳过鉴权)
    if (isPublic) {
      return true;
    }

    // 3. 否则执行父类 AuthGuard('jwt') 的校验逻辑 (进行 Token 验证)
    return super.canActivate(context);
  }
}


```

### Step 4: 注册模块与全局守卫

**这一步在干什么**: 将 Strategy 注册到 DI 容器，并启用全局守卫。

```typescript
// src/auth/auth.module.ts
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core'; // 引入 APP_GUARD
import { PassportModule } from '@nestjs/passport'; // 引入 PassportModule
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
// ... 其他 import

@Module({
  imports: [
    // ... 其他模块
    PassportModule, // 注册 Passport 模块
    // ...
  ],
  providers: [
    // ...
    JwtStrategy, // 注册策略
    {
      provide: APP_GUARD, // 注册全局守卫
      useClass: JwtAuthGuard,
    }
  ],
  // ... controllers, exports
})
export class AuthModule {}
```

### Step 5: 在控制器中使用

**这一步在干什么**: 标记登录接口为公开，并测试获取用户信息接口。

```typescript
// src/auth/auth.controller.ts
@Controller('auth')
export class AuthController {
  
  @Public() // 豁免登录，允许任何人访问
  @Post('login')
  async login(@Body() dto: LoginDTO) { ... }

  @ApiBearerAuth()
  @Get('info') // 默认需要登录，会被全局守卫拦截
  async info(@Request() req: any) {
    // req.user 由 JwtStrategy.validate 返回
    return this.authService.info(req.user.id);
  }
}
```
