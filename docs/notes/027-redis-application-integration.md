# 027. Redis 应用层集成 (Application Integration)

## 1. 核心问题与概念 

- **解决什么问题**:

  - 上一节我们已经准备好了 Redis 的 Docker 环境（基础设施层），现在需要在 NestJS 应用中（应用层）建立连接。
  - **连接复用**: 需要一个全局单例的 Redis 客户端，避免每次请求都建立新连接。
  - **配置管理**: 将 Redis 的连接参数（Host, Port, Password）纳入 ConfigModule 统一管理，避免硬编码。
- **核心概念与依赖**:

  - **ioredis**: Node.js 社区最流行、功能最强大的 Redis 客户端。相比官方的 `redis` 包，它对 Promise 支持更好，且内置了集群、哨兵等高级功能支持。
  - **Global Module**: Redis 连接通常是整个应用共享的基础设施，适合封装为 `@Global()` 模块，这样在其他模块使用时无需重复 import。
  - **Factory Provider**: 使用 `useFactory` 配合 `ConfigService` 动态创建 Redis 客户端实例。

## 2. 核心用法 / 方案设计 (Usage / Design)

### 场景: 注入 Redis 客户端进行操作

我们封装了一个全局的 `RedisModule`，并导出了一个 Token 为 `REDIS_CLIENT` 的 Provider。

```typescript
import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (configService: ConfigService) => {
        const redisConfig = configService.get('redis');
        return new Redis({
          host: redisConfig.host,
          port: redisConfig.port,
          password: redisConfig.password,
          db: redisConfig.db,
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}


```

## 3. 深度原理与机制 (Under the Hood)

- **模块设计**:
  - `RedisModule` 被设计为 **Global Module**。这意味着只要在 `AppModule` 中导入一次，整个应用的任何 Module 都可以直接使用 `@Inject(REDIS_CLIENT)`，大大减少了样板代码。
- **生命周期**:
  - `ioredis` 客户端在应用启动时（Module 初始化阶段）通过 factory 创建。
  - NestJS 的 DI 容器会持有这个单例实例。
  - 应用关闭时，NestJS 会自动处理 Provider 的销毁（如果实现了 OnModuleDestroy），但对于 ioredis，通常由 Node 进程退出处理连接断开，或者我们可以手动实现 `onModuleDestroy` 来优雅关闭连接（本阶段暂未实现，ioredis 默认会有心跳保持）。

### 什么是 `REDIS_CLIENT` Token?

在 NestJS 的依赖注入（DI）系统中，我们需要一个唯一的标识符来找到某个 Provider。

- **本质**: 它就是一个字符串常量 `'REDIS_CLIENT'`。
- **作用**: 就像去银行取钱需要的“存折账号”一样。
  - 在 `RedisModule` 中，我们告诉 NestJS：“嗨，把这个 Redis 实例存到 `'REDIS_CLIENT'` 这个账号下”。
  - 在 `AuthService` 中，我们通过 `@Inject('REDIS_CLIENT')` 告诉 NestJS：“嗨，请把 `'REDIS_CLIENT'` 这个账号里的东西取出来给我”。
- **为什么不用 Class**: 对于类（如 Service），NestJS 默认使用类本身作为 Token。但 `ioredis` 是一个第三方库的类，我们需要自定义配置（工厂模式），所以需要手动指定一个 Token。

### 核心疑问：我们需要连接池 (Connection Pool) 吗？

这是一个在 Java/Go 等多线程语言背景下常见的问题。

- **Node.js 的模型**: Node.js 是 **单线程 (Single Threaded)** 异步非阻塞的。这意味着同一时间只有一段 JS 代码在执行。
- **Redis 的模型**: Redis 服务端也是 **单线程** 的（大部分命令执行）。
- **结论**: 在 Node.js + Redis 场景下，**通常不需要传统意义上的连接池**（如 JDBC 几十个连接）。
  - 一个 `ioredis` 实例默认维护一个 TCP 长连接。
  - 它内部实现了 **Pipeling (管道)** 和 **Command Queueing (命令队列)**。
  - 在高并发下，所有请求会排队通过这**唯一的一条连接**发往 Redis，由于 Redis 极快（微妙级），这条连接通常不会成为瓶颈。
  - **最佳实践**: 我们当前采用的 **Singleton (单例模式)**，整个应用共享一个 `ioredis` 实例，实际上就是最高效的“连接池”（大小为 1 的池）。
  - **例外**: 只有在使用阻塞命令（如 `BLPOP`, `BRPOP`, `SUBSCRIBE`）时，才需要创建独立的连接实例，否则会阻塞其他常规命令。

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

- ✅ **推荐做法**:

  - 始终使用 ConfigService 获取配置。
  - 定义常量 Token (`REDIS_CLIENT`) 以避免魔术字符串拼写错误。
  - 在 Key 的命名上使用统一的前缀（如 `app:module:id`）以防止冲突。
- ❌ **避免做法**:

  - 在每个 Service 中手动 `new Redis()`。这会导致连接数爆炸。
  - 将 Redis 连接信息硬编码在 Module 中。

## 5. 生产环境部署清单 (Production Checklist)

在将应用部署到生产环境前，请务必检查以下 Redis 相关项：

1.  **独立部署**: 生产环境通常使用云服务商的 Redis (AWS ElastiCache, 阿里云 Redis) 或独立服务器，不要依赖本地 `localhost`。
2.  **安全配置**:
    - **密码强校验**: 必须启用 `requirepass`，且密码复杂度要高。
    - **网络隔离**: Redis **绝对不要**暴露在公网端口 (0.0.0.0)，应仅绑定在内网 IP 或通过 VPC 访问。
3.  **Key 前缀隔离**: 如果多个应用共用同一个 Redis 实例，务必在 Key 设计上加上前缀（如 `crm:user:1` vs `mall:user:1`），防止数据覆盖。
4.  **超时设置**: 检查 `connectTimeout` 配置，避免网络波动导致应用启动挂死。
5.  **持久化策略**: 确认 AOF/RDB 策略符合业务对数据丢失的容忍度。

## 6. 行动导向 (Action Guide)

### Step 1: 安装依赖

**这一步在干什么**: 安装 `ioredis` 客户端库。NestJS 官方虽然有 `cache-manager`，但对于直接操作 Redis（如实现分布式锁、Session），直接使用 `ioredis` 更灵活。

```bash
# ioredis 自带类型定义，无需安装 @types/ioredis
npm install ioredis
```

### Step 2: 配置环境变量与校验

**这一步在干什么**: 在 `env.ai` (及 `.env`) 中添加 Redis 配置，并更新 `AppConfigModule` 进行 Joi 校验，确保应用启动时配置正确。

**修改 `src/common/configs/app-config.module.ts`**:

```typescript
// ... Joi.object({
  // Redis 配置
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),
  REDIS_DB: Joi.number().default(0),
// ...
```

### Step 3: 创建全局 Redis 模块

**这一步在干什么**: 创建 `RedisModule`，封装 `ioredis` 的实例化逻辑。

**创建 `src/common/redis/redis.module.ts`**:

```typescript
import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (configService: ConfigService) => {
        const redisConfig = configService.get('redis');
        return new Redis({
          host: redisConfig.host,
          port: redisConfig.port,
          password: redisConfig.password,
          db: redisConfig.db,
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}


```

### Step 4: 注册到 AppModule

**这一步在干什么**: 将 `RedisModule` 导入到根模块，使其生效。

**修改 `src/app.module.ts`**:

```typescript
@Module({
  imports: [
    // ...
    RedisModule, // 注册 Redis 模块
    // ...
  ],
})
export class AppModule {}
```
