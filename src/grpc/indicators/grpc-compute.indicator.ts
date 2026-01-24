/**
 * gRPC 计算服务健康检查指示器
 *
 * 用于 @nestjs/terminus 健康检查模块
 * 检查 Go 计算服务的可用性
 *
 * 使用 HealthIndicatorService (v11+) 替代已弃用的 HealthIndicator 基类
 */
import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorService,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { ImageServiceClient } from '../clients';

@Injectable()
export class GrpcComputeHealthIndicator {
  constructor(
    private readonly imageClient: ImageServiceClient,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  /**
   * 检查 gRPC 计算服务健康状态
   *
   * @param key 健康检查键名
   * @returns 健康检查结果
   */
  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    // 使用新的 HealthIndicatorService API
    const indicator = this.healthIndicatorService.check(key);

    try {
      const isAvailable = await this.imageClient.isAvailable();

      if (isAvailable) {
        return indicator.up({
          message: 'gRPC Compute Service is available',
        });
      }

      // 服务返回非 SERVING 状态
      return indicator.down({
        message: 'Service returned NOT_SERVING status',
      });
    } catch (error) {
      // 服务不可达或其他错误
      return indicator.down({
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}
