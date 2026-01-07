# 029. 基于 Rate Limiting 的频次控制 (Rate Limiting)

## 1. 核心问题与概念

### 1.1 需求背景：为什么需要限流？

应用程序通过公开 API 处理外部请求，这一特性使其天然暴露在多种风险之下。限流（Rate Limiting）是系统自我保护的第一道防线，主要解决以下三个核心问题：

1. **防御拒绝服务攻击 (DoS/DDoS)**：
   恶意攻击者或失控的脚本可能在短时间内发送海量请求（例如每秒数千次），导致服务器 CPU、内存或数据库连接池耗尽，从而使正常用户的请求无法被处理。
2. **暴力破解防护 (Brute Force Protection)**：
   在登录、验证码校验等敏感接口，攻击者可能通过穷举法尝试撞库。限流可以显著增加攻击的时间成本，使其在经济上不可行。
3. **资源公平分配 (Fair Usage)**：
   即使没有恶意攻击，某些高频用户或集成方也可能无意中占用过多计算资源。限流确保了单一用户无法通过过量请求挤占其他用户的资源配额。

## 2. 方案对比与选型 (Comparison)

### 2.1 传统方案：Express Rate Limit

**`express-rate-limit`** 是 Node.js 生态中最基础的限流中间件。

- **实现方式**：它作为一个标准的 Express 中间件运行，通过拦截 HTTP 请求并记录 IP 访问次数来工作。
- **局限性**：
  - **状态隔离**：默认将计数器存储在进程内存中。在现代容器化（Docker/K8s）或多进程（PM2 Cluster）部署架构下，每个实例维护独立的计数器。这导致限流阈值随着实例数量线性倍增，无法实现全局统一限流。
  - **架构脱节**：它不属于 NestJS 的依赖注入体系，难以与 Guard（守卫）、Interceptor（拦截器）等 NestJS 原生组件协同工作，也难以针对特定的 Controller 或 Method 进行细粒度的元数据配置。

### 2.2 进阶方案：NestJS Throttler + Redis (推荐)

**`@nestjs/throttler`** 是 NestJS 官方提供的限流模块，结合 Redis 存储适配器。

- **实现方式**：基于 NestJS 的 **Guard (守卫)** 机制实现。请求在进入 Controller 之前，先经过 `ThrottlerGuard`，守卫根据上下文（Context）提取指纹（Fingerprint），并向后端存储查询配额。
- **优势分析**：
  - **分布式状态一致性**：通过引入 Redis 作为外部存储（Storage Driver），无论后端部署了多少个服务实例，所有请求都共享同一份计数器，实现了真正的全局精准限流。
  - **声明式控制**：利用 NestJS 的元数据反射能力，支持通过 `@Throttle()` 和 `@SkipThrottle()` 装饰器，在类或方法级别定义差异化的限流策略（例如：登录接口 5次/分，普通接口 100次/分）。
  - **高度可扩展**：支持自定义追踪器（Tracker），不仅可以按 IP 限流，还能轻松扩展为按 User ID、API Key 或租户 ID 限流。

## 3. 深度原理与机制 (Under the Hood)

### 3.1 运行机制

NestJS 的限流方案通过以下生命周期运作：

1. **请求拦截**：请求到达服务器，进入 `ThrottlerGuard`。
2. **指纹生成 (Fingerprinting)**：守卫默认读取客户端 IP（支持 `X-Forwarded-For` 解析）作为唯一标识。
3. **原子性检查 (Atomic Check)**：守卫调用 Redis 的原子指令（Lua 脚本或 INCR/TTL 组合）。
   - 如果 Key 不存在：设置 Key = 1，并设置过期时间（TTL）。
   - 如果 Key 存在：自增 Key 的值。
4. **决策判定**：
   - 如果当前值 <= 阈值 (Limit)：请求放行 (Pass)。
   - 如果当前值 > 阈值：抛出 `ThrottlerException`，框架自动捕获并返回 HTTP 429 Too Many Requests 响应。

### 3.2 存储层设计

我们使用 Redis 的 `INCR` 和 `EXPIRE` 命令来维护滑动窗口或固定窗口的计数。这种设计避免了在应用层进行复杂的并发锁控制，利用 Redis 单线程特性保证了高并发下的计数准确性。

## 4. 行动导向 (Action Guide)

### Step 1: 安装核心依赖

**这一步在干什么**: 安装 NestJS 官方限流模块及 Redis 存储适配器。

```bash
npm install @nestjs/throttler @nest-lab/throttler-storage-redis
```

### Step 2: 注册全局模块

**这一步在干什么**: 在 `AppModule` 中配置限流规则和 Redis 连接。通过 `forRootAsync` 读取配置服务，确保不硬编码敏感信息。

**修改 `src/app.module.ts`**:

```typescript
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { APP_GUARD } from '@nestjs/core';

@Module({
  imports: [
    // ... 其他模块
  
    // 🛡️ 注册速率限制模块
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        errorMessage: '当前请求过于频繁，请稍后再试', // 自定义错误信息
        throttlers: [
          {
            ttl: 60000, // 时间窗口：60000ms (1分钟)
            limit: 60,  // 最大请求数：60次
          },
        ],
        // 关键：配置 Redis 存储适配器实现分布式限流
        storage: new ThrottlerStorageRedisService({
          host: config.get('redis.host'),
          port: config.get('redis.port'),
          password: config.get('redis.password'),
          db: config.get('redis.db'),
        }),
      }),
    }),
  ],
  providers: [
    // 注册全局守卫，使限流策略对所有接口生效
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
```

### Step 3: 配置代理信任 (关键)

**这一步在干什么**: 如果应用部署在 Nginx 或负载均衡器后，必须告诉 Express 信任代理头，否则所有请求的 IP 都会变成代理服务器的内网 IP，导致全站所有用户共享同一个限流配额（瞬间被封锁）。

**警告：IP 伪造风险**
在**没有**前置代理（如本地开发或直接暴露公网）的情况下，如果开启 `app.set('trust proxy', 1)`，攻击者可以通过手动添加 `X-Forwarded-For: <任意IP>` 头来伪造客户端 IP，从而轻松绕过限流。因此，**仅在确实部署于 Nginx 等代理后方时开启此配置**。

**修改 `src/main.ts`**:

```typescript
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  
  // ⚠️ 生产环境必须配置！
  // 信任前端代理 (Nginx/Load Balancer) 传递的 X-Forwarded-For 头
  // 1 表示信任第一层代理，根据实际部署架构调整
  // ⚠️ 注意：如果直接暴露在公网或本地开发，请注释掉此行，否则有 IP 伪造风险
  // app.set('trust proxy', 1);

  // ...
}
```

### Step 4: 细粒度策略控制 (可选)

**这一步在干什么**: 针对特殊接口覆盖全局配置。

**场景 A: 豁免限流 (如健康检查)**

```typescript
import { SkipThrottle } from '@nestjs/throttler';

@SkipThrottle()
@Get('health')
check() { return 'ok'; }
```

**场景 B: 强化限流 (如登录接口)**

```typescript
import { Throttle } from '@nestjs/throttler';

// 覆盖默认设置：1分钟内只能请求 5 次
@Throttle({ default: { limit: 5, ttl: 60000 } })
@Post('login')
login() { ... }
```
