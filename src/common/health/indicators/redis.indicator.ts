import { Injectable, Inject } from '@nestjs/common';

import { HealthIndicatorService } from '@nestjs/terminus';
import Redis from 'ioredis';

import { REDIS_CLIENT } from '../../redis/redis.module';

/**
 * 自定义 Redis 健康指示器
 * 使用 HealthIndicatorService (v11+) 基类
 */
@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /**
   * 检查 Redis 连接状态
   * @param key - 在健康检查结果中显示的标识符
   */
  async isHealthy(key: string) {
    const indicator = this.healthIndicatorService.check(key);

    try {
      // PING 是 Redis 最轻量的健康检查命令
      const response = await this.redis.ping();
      const isHealthy = response === 'PONG';

      if (isHealthy) {
        // 不要覆盖 status 字段，Terminus 依赖 status: 'up' 来判断健康状态
        return indicator.up();
      }

      return indicator.down();
    } catch (error) {
      // 捕获连接错误等异常情况
      return indicator.down({
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
