/**
 * 计算服务 gRPC 客户端封装
 *
 * 职责：
 * 1. 封装 gRPC 客户端，提供 Promise/Observable 两种调用方式
 * 2. 统一处理超时、重试、错误转换
 * 3. 对业务层屏蔽 gRPC 底层细节
 */
import {
  Injectable,
  Inject,
  OnModuleInit,
  Logger,
  ServiceUnavailableException,
  RequestTimeoutException,
} from '@nestjs/common';
import type { ClientGrpc } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';
import {
  Observable,
  firstValueFrom,
  timeout,
  retry,
  catchError,
  throwError,
  tap,
  timer,
} from 'rxjs';
import { GRPC_COMPUTE_SERVICE } from '../constants';
import {
  ComputeServiceClient as IComputeServiceClient,
  CalculateRequest,
  CalculateResponse,
  CalculateChunk,
  HealthCheckResponse,
} from '../interfaces';

@Injectable()
export class ComputeServiceClient implements OnModuleInit {
  private readonly logger = new Logger(ComputeServiceClient.name);
  private computeService: IComputeServiceClient;
  private readonly defaultTimeout: number;
  private readonly retryAttempts: number;
  private readonly retryDelay: number;

  constructor(
    @Inject(GRPC_COMPUTE_SERVICE) private readonly client: ClientGrpc,
    private readonly configService: ConfigService,
  ) {
    const options = this.configService.get('grpc.options');
    this.defaultTimeout = options?.defaultTimeout || 30000;
    this.retryAttempts = options?.retryAttempts || 2;
    this.retryDelay = options?.retryDelay || 1000;
  }

  /**
   * 模块初始化时获取 gRPC 服务实例
   * NestJS 生命周期钩子，在依赖注入完成后自动调用
   */
  onModuleInit() {
    const serviceName = this.configService.get('grpc.compute.serviceName');
    this.computeService =
      this.client.getService<IComputeServiceClient>(serviceName);
    this.logger.log(`gRPC ComputeService 客户端已初始化`);
  }

  /**
   * 同步计算 (Promise 封装)
   *
   * 适用场景：需要完整结果的同步调用
   *
   * @param request 计算请求
   * @param timeoutMs 超时时间 (毫秒)，默认使用配置值
   * @returns 计算响应
   * @throws ServiceUnavailableException 服务不可用
   * @throws RequestTimeoutException 请求超时
   */
  async calculate(
    request: CalculateRequest,
    timeoutMs?: number,
  ): Promise<CalculateResponse> {
    const effectiveTimeout = timeoutMs || this.defaultTimeout;

    this.logger.debug(
      `发起计算请求: taskId=${request.taskId}, type=${request.taskType}`,
    );

    try {
      const response = await firstValueFrom(
        this.computeService.calculate(request).pipe(
          timeout(effectiveTimeout),
          retry({
            count: this.retryAttempts,
            delay: (error, retryCount) => {
              this.logger.warn(
                `计算请求重试 (${retryCount}/${this.retryAttempts}): ${error.message}`,
              );
              return timer(this.retryDelay);
            },
          }),
          tap((res) => {
            this.logger.debug(
              `计算完成: taskId=${res.taskId}, elapsed=${res.elapsedMs}ms`,
            );
          }),
          catchError((error) => this.handleError(error, request.taskId)),
        ),
      );

      return response;
    } catch (error) {
      // firstValueFrom 可能抛出错误，需要再次捕获
      throw this.transformError(error, request.taskId);
    }
  }

  /**
   * 流式计算 (Observable)
   *
   * 适用场景：
   * - 大数据处理，需要分块返回
   * - AI 推理，需要流式输出
   * - 长时间任务，需要进度反馈
   *
   * @param request 计算请求
   * @returns 流式响应 Observable
   */
  streamCalculate(request: CalculateRequest): Observable<CalculateChunk> {
    this.logger.debug(
      `发起流式计算请求: taskId=${request.taskId}, type=${request.taskType}`,
    );

    return this.computeService.streamCalculate(request).pipe(
      tap((chunk) => {
        if (chunk.isFinal) {
          this.logger.debug(
            `流式计算完成: taskId=${chunk.taskId}, totalChunks=${chunk.index + 1}`,
          );
        }
      }),
      catchError((error) => this.handleError(error, request.taskId)),
    );
  }

  /**
   * 健康检查
   *
   * @returns 服务健康状态
   */
  async checkHealth(): Promise<HealthCheckResponse> {
    try {
      return await firstValueFrom(
        this.computeService.healthCheck({ service: '' }).pipe(
          timeout(5000), // 健康检查使用较短超时
          catchError((error) => this.handleError(error, 'health-check')),
        ),
      );
    } catch (error) {
      throw this.transformError(error, 'health-check');
    }
  }

  /**
   * 检查服务是否可用
   *
   * @returns 是否可用
   */
  async isAvailable(): Promise<boolean> {
    try {
      const health = await this.checkHealth();
      // status: 1 = SERVING
      return health.status === 1;
    } catch {
      return false;
    }
  }

  /**
   * 统一错误处理管道
   */
  private handleError(
    error: Error,
    taskId: string,
  ): Observable<never> {
    return throwError(() => this.transformError(error, taskId));
  }

  /**
   * 错误转换
   * 将 gRPC 错误转换为 NestJS HTTP 异常
   */
  private transformError(error: unknown, taskId: string): Error {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // 超时错误
    if (errorMessage.includes('Timeout') || errorMessage.includes('DEADLINE_EXCEEDED')) {
      this.logger.error(`请求超时: taskId=${taskId}`);
      return new RequestTimeoutException(
        `gRPC 请求超时: ${taskId}`,
      );
    }

    // 连接错误
    if (
      errorMessage.includes('UNAVAILABLE') ||
      errorMessage.includes('ECONNREFUSED') ||
      errorMessage.includes('Connection')
    ) {
      this.logger.error(`服务不可用: taskId=${taskId}, error=${errorMessage}`);
      return new ServiceUnavailableException(
        `计算服务暂时不可用，请稍后重试`,
      );
    }

    // 其他错误
    this.logger.error(`gRPC 调用失败: taskId=${taskId}, error=${errorMessage}`);
    return new ServiceUnavailableException(
      `计算服务调用失败: ${errorMessage}`,
    );
  }
}
