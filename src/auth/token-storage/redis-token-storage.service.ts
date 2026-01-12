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
