# 035. Refresh Token 存储迁移：从数据库到 Redis

## 1. 核心问题与概念 

### 解决什么问题？

在双 Token 鉴权体系中，Refresh Token 需要**有状态存储**以支持撤销功能。原有方案将其存储在 PostgreSQL 数据库的 `users` 表中，存在以下问题：

1. **性能瓶颈**：每次 Token 刷新和登出都需要写盘操作
2. **无自动过期**：需要手动清理过期 Token，或依赖 JWT 自身的过期机制
3. **扩展性差**：多设备登录场景需要改表结构（数组/关联表）

### 核心概念与依赖

| 概念                     | 说明                                                              |
| ------------------------ | ----------------------------------------------------------------- |
| **Redis TTL**      | Redis 原生支持 Key 过期时间，Token 过期后自动清理，无需定时任务   |
| **DIP (依赖倒置)** | 业务层依赖抽象接口，而非具体的 Redis 实现，便于测试和切换存储后端 |
| **Token 存储分离** | 将 Token 存储职责从 UserService 中剥离，遵循单一职责原则          |

---

## 2. 核心用法 / 方案设计 (Usage / Design)

### 架构设计：抽象层 + 策略模式

```
┌─────────────────┐
│   AuthService   │  ← 业务层，依赖抽象接口
└────────┬────────┘
         │ @Inject(TOKEN_STORAGE_SERVICE)
         ▼
┌─────────────────────────┐
│  ITokenStorageService   │  ← 抽象接口（DIP）
└────────┬────────────────┘
         │ implements
         ▼
┌─────────────────────────┐
│ RedisTokenStorageService│  ← 具体实现
└─────────────────────────┘
```

### Redis Key 设计

```
# Key 格式
auth:refresh:{userId}

# 示例
auth:refresh:550e8400-e29b-41d4-a716-446655440000

# 值
bcrypt 哈希后的 Refresh Token（非明文）

# TTL
与 JWT_REFRESH_EXPIRES_IN 配置一致（默认 7 天）
```

### 场景 A: 登录/注册流程

```typescript
// 1. 生成双 Token
const tokens = await this.getTokens(userId, phoneNumber);

// 2. 哈希后存入 Redis（带 TTL）
const hashedToken = await this.hashingService.hash(tokens.refresh_token);
await this.tokenStorage.set(userId, hashedToken, ttlSeconds);

// 3. 返回给客户端
return tokens;
```

### 场景 B: Token 刷新流程

```typescript
// 1. 从 Redis 获取存储的哈希
const storedHash = await this.tokenStorage.get(userId);
if (!storedHash) throw new ForbiddenException('访问被拒绝');

// 2. 比对请求中的 Token 与存储的哈希
const isValid = await this.hashingService.compare(refreshToken, storedHash);
if (!isValid) throw new ForbiddenException('Refresh Token 无效');

// 3. Token 轮换：签发新 Token 并更新 Redis
const newTokens = await this.getTokens(userId, phoneNumber);
await this.storeRefreshToken(userId, newTokens.refresh_token);
```

### 场景 C: 用户登出

```typescript
// 直接删除 Redis Key，Token 立即失效
await this.tokenStorage.delete(userId);
```

---

## 3. 深度原理与机制 (Under the Hood)

### 3.1 接口定义：ITokenStorageService

```typescript
export interface ITokenStorageService {
  set(userId: string, hashedToken: string, ttlSeconds: number): Promise<void>;
  get(userId: string): Promise<string | null>;
  delete(userId: string): Promise<void>;
  exists(userId: string): Promise<boolean>;
}

// 依赖注入 Token
export const TOKEN_STORAGE_SERVICE = 'TOKEN_STORAGE_SERVICE';
```

**设计要点**：

- 方法签名简洁，只关注存储语义，不暴露 Redis 细节
- 提供 `exists()` 方法用于快速判断登录态（避免获取完整数据）
- 使用字符串常量作为 DI Token，支持接口注入

### 3.2 Redis 实现：关键操作

```typescript
// SETEX: 原子操作，同时设置值和过期时间
await this.redis.setex(key, ttlSeconds, hashedToken);

// GET: 返回 null 表示 key 不存在或已过期
const value = await this.redis.get(key);

// DEL: 删除 key
await this.redis.del(key);

// EXISTS: 检查 key 是否存在（返回 0 或 1）
const result = await this.redis.exists(key);
```

### 3.3 TTL 解析：时间字符串转秒数

```typescript
export function parseExpiresInToSeconds(expiresIn: string): number {
  const match = expiresIn.match(/^(\d+)([smhd])$/);
  if (!match) return 604800; // 默认 7 天

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's': return value;
    case 'm': return value * 60;
    case 'h': return value * 3600;
    case 'd': return value * 86400;
    default: return 604800;
  }
}
```

### 3.4 数据库 vs Redis 对比

| 维度       | 数据库存储      | Redis 存储         |
| ---------- | --------------- | ------------------ |
| 读写性能   | 磁盘 I/O        | 内存操作，更快     |
| 过期清理   | 需手动/定时任务 | TTL 自动清理       |
| 多设备支持 | 需改表结构      | 天然支持（多 Key） |
| 数据持久化 | 天然持久        | 需配置 AOF/RDB     |
| 审计追溯   | 支持            | 需额外日志         |

---

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

### ✅ 推荐做法

1. **存储哈希而非明文**：即使 Redis 泄露，攻击者也无法直接使用 Token
2. **TTL 与 JWT 过期时间同步**：避免数据不一致
3. **Key 命名规范**：使用 `{业务域}:{资源类型}:{标识符}` 格式
4. **接口抽象**：依赖接口而非具体实现，便于单元测试和切换存储后端

### ❌ 避免做法

1. **不要存储明文 Token**：Redis 数据可能被导出或泄露
2. **不要忽略 Redis 连接失败**：应有优雅降级或重试机制
3. **不要在业务代码中硬编码 Key 前缀**：集中管理常量

---

## 5. 行动导向 (Action Guide)

### Step 1: 创建 Token 存储目录结构

**这一步在干什么**：建立模块化的目录结构，分离接口定义和具体实现。

```bash
# 在 src/auth 目录下创建 token-storage 子目录
mkdir src/auth/token-storage
```

目录结构：

```
src/auth/token-storage/
├── index.ts                        # 统一导出
├── token-storage.interface.ts      # 抽象接口
├── token-storage.constants.ts      # 常量定义
└── redis-token-storage.service.ts  # Redis 实现
```

### Step 2: 定义抽象接口

**这一步在干什么**：遵循 DIP 原则，定义与存储后端无关的接口契约。

```typescript
// src/auth/token-storage/token-storage.interface.ts
/**
 * Token 存储服务抽象接口
 * 遵循 DIP 原则，业务层依赖此接口而非具体实现
 * 支持 Redis/Database 等不同存储后端的切换
 */
export interface ITokenStorageService {
  /**
   * 存储 Refresh Token 哈希值
   * @param userId 用户唯一标识
   * @param hashedToken bcrypt 哈希后的 Token（非明文）
   * @param ttlSeconds 过期时间（秒），与 JWT 过期时间保持一致
   */
  set(userId: string, hashedToken: string, ttlSeconds: number): Promise<void>;

  /**
   * 获取存储的 Refresh Token 哈希值
   * @param userId 用户唯一标识
   * @returns 哈希值字符串，不存在或已过期返回 null
   */
  get(userId: string): Promise<string | null>;

  /**
   * 删除（撤销）用户的 Refresh Token
   * 用于登出场景，使 Token 立即失效
   * @param userId 用户唯一标识
   */
  delete(userId: string): Promise<void>;

  /**
   * 检查用户是否存在有效的 Refresh Token
   * 用于快速判断登录态，避免获取完整数据
   * @param userId 用户唯一标识
   */
  exists(userId: string): Promise<boolean>;
}

/**
 * 依赖注入 Token，用于在 NestJS IoC 容器中标识此接口
 */
export const TOKEN_STORAGE_SERVICE = 'TOKEN_STORAGE_SERVICE';

```

### Step 3: 定义常量

**这一步在干什么**：集中管理 Redis Key 前缀和时间换算逻辑，避免魔法字符串。

```typescript
// src/auth/token-storage/token-storage.constants.ts
/**
 * Token 存储相关常量
 * 集中管理 Redis Key 前缀和其他配置常量
 */

/**
 * Redis Key 前缀
 * 命名规范：{业务域}:{资源类型}:{标识符}
 */
export const REDIS_KEY_PREFIX = {
  /**
   * Refresh Token 存储 Key 前缀
   * 完整格式：auth:refresh:{userId}
   */
  REFRESH_TOKEN: 'auth:refresh',
} as const;

/**
 * 时间单位换算（秒）
 */
export const TIME_IN_SECONDS = {
  MINUTE: 60,
  HOUR: 3600,
  DAY: 86400,
  WEEK: 604800,
} as const;

/**
 * 将 JWT 过期时间字符串解析为秒数
 * 支持格式：15m, 1h, 7d, 30d 等
 * @param expiresIn JWT 过期时间字符串
 * @returns 秒数
 */
export function parseExpiresInToSeconds(expiresIn: string): number {
  const match = expiresIn.match(/^(\d+)([smhd])$/);
  if (!match) {
    // 默认 7 天
    return TIME_IN_SECONDS.WEEK;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's':
      return value;
    case 'm':
      return value * TIME_IN_SECONDS.MINUTE;
    case 'h':
      return value * TIME_IN_SECONDS.HOUR;
    case 'd':
      return value * TIME_IN_SECONDS.DAY;
    default:
      return TIME_IN_SECONDS.WEEK;
  }
}

```

### Step 4: 实现 Redis 存储服务

**这一步在干什么**：实现 `ITokenStorageService` 接口，封装 Redis 操作细节。

```typescript
// src/auth/token-storage/redis-token-storage.service.ts
import { Injectable, Inject, Logger } from '@nestjs/common';

import Redis from 'ioredis';

import { ITokenStorageService } from './token-storage.interface';
import { REDIS_KEY_PREFIX } from './token-storage.constants';
import { REDIS_CLIENT } from '../../common/redis/redis.module';

/**
 * 基于 Redis 的 Token 存储实现
 * 利用 Redis TTL 特性实现自动过期清理
 */
@Injectable()
export class RedisTokenStorageService implements ITokenStorageService {
  private readonly logger = new Logger(RedisTokenStorageService.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
  ) {}

  /**
   * 构建 Redis Key
   * 格式：auth:refresh:{userId}
   */
  private buildKey(userId: string): string {
    return `${REDIS_KEY_PREFIX.REFRESH_TOKEN}:${userId}`;
  }

  async set(userId: string, hashedToken: string, ttlSeconds: number): Promise<void> {
    const key = this.buildKey(userId);
  
    // SETEX: 原子操作，同时设置值和过期时间
    await this.redis.setex(key, ttlSeconds, hashedToken);
  
    this.logger.debug(`Refresh Token stored for user ${userId}, TTL: ${ttlSeconds}s`);
  }

  async get(userId: string): Promise<string | null> {
    const key = this.buildKey(userId);
    const value = await this.redis.get(key);
  
    // Redis 返回 null 表示 key 不存在或已过期
    return value;
  }

  async delete(userId: string): Promise<void> {
    const key = this.buildKey(userId);
    await this.redis.del(key);
  
    this.logger.debug(`Refresh Token revoked for user ${userId}`);
  }

  async exists(userId: string): Promise<boolean> {
    const key = this.buildKey(userId);
    // EXISTS 返回 1 表示存在，0 表示不存在
    const result = await this.redis.exists(key);
    return result === 1;
  }
}

```

### Step 5: 注册 Provider 到 AuthModule

**这一步在干什么**：将接口与实现绑定，注入 NestJS IoC 容器。

```typescript
// src/auth/auth.module.ts
import { TOKEN_STORAGE_SERVICE, RedisTokenStorageService } from './token-storage';

@Module({
  // ...
  providers: [
    // ...
    // Token 存储服务：基于接口注入
    {
      provide: TOKEN_STORAGE_SERVICE,
      useClass: RedisTokenStorageService,
    },
    // ...
  ],
})
export class AuthModule {}
```

### Step 6: 重构 AuthService

**这一步在干什么**：使用新的 Token 存储接口替代直接调用 UserService。

```typescript
// src/auth/auth.service.ts
// 注意：接口必须使用 import type 导入，以满足 isolatedModules + emitDecoratorMetadata 要求
import type { ITokenStorageService } from './token-storage';
import { TOKEN_STORAGE_SERVICE, parseExpiresInToSeconds } from './token-storage';

@Injectable()
export class AuthService {
  constructor(
    // ...
    @Inject(TOKEN_STORAGE_SERVICE)
    private readonly tokenStorage: ITokenStorageService,
  ) {}

  // 登录/注册时存储 Token
  private async storeRefreshToken(userId: string, refreshToken: string): Promise<void> {
    const hashedToken = await this.hashingService.hash(refreshToken);
    const expiresIn = this.configService.get<string>('jwt.refreshExpiresIn') ?? '7d';
    const ttlSeconds = parseExpiresInToSeconds(expiresIn);
    await this.tokenStorage.set(userId, hashedToken, ttlSeconds);
  }

  // 刷新时验证 Token
  async refreshTokens(userId: string, refreshToken: string): Promise<TokensDto> {
    const storedHash = await this.tokenStorage.get(userId);
    if (!storedHash) throw new ForbiddenException('访问被拒绝');
    // ...
  }

  // 登出时删除 Token
  async logout(userId: string): Promise<void> {
    await this.tokenStorage.delete(userId);
  }
}
```

### Step 7: 清理废弃代码

**这一步在干什么**：移除 UserService 中不再使用的 Token 相关方法。

从 `user.service.ts` 中删除：

- `updateRefreshToken()` 方法
- `findOneWithRefreshToken()` 方法

**注意**：`User` 实体中的 `currentHashedRefreshToken` 字段暂时保留，后续通过 Migration 移除。
