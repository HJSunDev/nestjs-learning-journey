import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import {
  HealthCheckService,
  HealthCheck,
  TypeOrmHealthIndicator,
  DiskHealthIndicator,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { Public } from '../decorators/public.decorator';
import { RedisHealthIndicator } from './indicators/redis.indicator';

/**
 * 健康检查控制器
 * 提供多个端点用于不同场景的健康检查
 */
@ApiTags('Health Check')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly disk: DiskHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /**
   * 完整健康检查
   * 适用于运维监控面板，包含所有依赖服务的状态
   */
  @Get()
  @Public()
  @HealthCheck()
  @ApiOperation({ summary: '完整健康检查 (所有服务)' })
  check() {
    return this.health.check([
      // PostgreSQL 数据库检查
      () => this.db.pingCheck('database'),

      // Redis 服务检查
      () => this.redis.isHealthy('redis'),

      // 磁盘空间检查 (阈值: 使用率超过 90% 告警)
      () =>
        this.disk.checkStorage('storage', {
          path: process.cwd(),
          thresholdPercent: 0.9,
        }),

      // 内存检查 (阈值: 堆内存超过 300MB 告警)
      () => this.memory.checkHeap('memory_heap', 300 * 1024 * 1024),
    ]);
  }

  /**
   * 存活探针 (Liveness Probe)
   * 适用于 Kubernetes/Docker，仅检查应用进程是否存活
   * 此端点响应极快，不检查外部依赖
   */
  @Get('liveness')
  @Public()
  @ApiOperation({ summary: '存活探针 (K8s Liveness)' })
  liveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * 就绪探针 (Readiness Probe)
   * 适用于 Kubernetes/Docker，检查核心依赖是否就绪
   * 数据库和缓存必须可用，应用才算就绪
   */
  @Get('readiness')
  @Public()
  @HealthCheck()
  @ApiOperation({ summary: '就绪探针 (K8s Readiness)' })
  readiness() {
    return this.health.check([
      () => this.db.pingCheck('database'),
      () => this.redis.isHealthy('redis'),
    ]);
  }
}
