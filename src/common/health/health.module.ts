import { Module } from '@nestjs/common';

import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller';
import { RedisHealthIndicator } from './indicators/redis.indicator';

/**
 * 健康检查模块
 * 集成 @nestjs/terminus 并注册自定义指示器
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [RedisHealthIndicator],
})
export class HealthModule {}
