/**
 * 图像处理服务 gRPC 客户端
 *
 * 职责：
 * 1. 从共享的 gRPC 连接中获取 ImageService 代理
 * 2. 封装图像处理业务方法，提供 Promise API
 * 3. 统一处理超时、重试、错误转换
 *
 * 设计说明：
 * - 共享连接：与其他 Client 共享同一个 GRPC_COMPUTE_SERVICE 连接
 * - 独立代理：通过 getService('ImageService') 获取专属服务代理
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
  IImageServiceClient,
  IHealthServiceClient,
  CompressRequest,
  CompressResponse,
  ResizeRequest,
  ResizeResponse,
  WatermarkRequest,
  WatermarkResponse,
  BatchProcessRequest,
  ProcessChunk,
  HealthCheckResponse,
} from '../interfaces';

@Injectable()
export class ImageServiceClient implements OnModuleInit {
  private readonly logger = new Logger(ImageServiceClient.name);
  private imageService: IImageServiceClient;
  private healthService: IHealthServiceClient;
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
   * 模块初始化时获取 gRPC 服务代理
   *
   * 从共享的 ClientGrpc 连接中获取 ImageService 和 HealthService
   */
  onModuleInit() {
    this.imageService = this.client.getService<IImageServiceClient>('ImageService');
    this.healthService = this.client.getService<IHealthServiceClient>('HealthService');
    this.logger.log('gRPC ImageService 客户端已初始化');
  }

  // =========================================================================
  // 图像压缩
  // =========================================================================

  /**
   * 压缩图像
   *
   * @param request 压缩请求
   * @param timeoutMs 超时时间 (毫秒)
   */
  async compress(
    request: CompressRequest,
    timeoutMs?: number,
  ): Promise<CompressResponse> {
    const effectiveTimeout = timeoutMs || this.defaultTimeout;

    this.logger.debug(
      `压缩请求: size=${request.imageData.length}, quality=${request.quality}`,
    );

    try {
      const response = await firstValueFrom(
        this.imageService.compress(request).pipe(
          timeout(effectiveTimeout),
          retry({
            count: this.retryAttempts,
            delay: (error, retryCount) => {
              this.logger.warn(`压缩重试 (${retryCount}/${this.retryAttempts})`);
              return timer(this.retryDelay);
            },
          }),
          tap((res) => {
            this.logger.debug(
              `压缩完成: ratio=${res.compressionRatio.toFixed(2)}, elapsed=${res.elapsedMs}ms`,
            );
          }),
          catchError((error) => this.handleError(error, 'compress')),
        ),
      );

      return response;
    } catch (error) {
      throw this.transformError(error, 'compress');
    }
  }

  // =========================================================================
  // 图像缩放
  // =========================================================================

  /**
   * 缩放图像
   *
   * @param request 缩放请求
   * @param timeoutMs 超时时间 (毫秒)
   */
  async resize(
    request: ResizeRequest,
    timeoutMs?: number,
  ): Promise<ResizeResponse> {
    const effectiveTimeout = timeoutMs || this.defaultTimeout;

    this.logger.debug(
      `缩放请求: targetSize=${request.width}x${request.height}`,
    );

    try {
      const response = await firstValueFrom(
        this.imageService.resize(request).pipe(
          timeout(effectiveTimeout),
          retry({
            count: this.retryAttempts,
            delay: (_, retryCount) => {
              this.logger.warn(`缩放重试 (${retryCount}/${this.retryAttempts})`);
              return timer(this.retryDelay);
            },
          }),
          tap((res) => {
            this.logger.debug(
              `缩放完成: ${res.originalWidth}x${res.originalHeight} -> ${res.newWidth}x${res.newHeight}`,
            );
          }),
          catchError((error) => this.handleError(error, 'resize')),
        ),
      );

      return response;
    } catch (error) {
      throw this.transformError(error, 'resize');
    }
  }

  // =========================================================================
  // 添加水印
  // =========================================================================

  /**
   * 添加水印
   *
   * @param request 水印请求
   * @param timeoutMs 超时时间 (毫秒)
   */
  async watermark(
    request: WatermarkRequest,
    timeoutMs?: number,
  ): Promise<WatermarkResponse> {
    const effectiveTimeout = timeoutMs || this.defaultTimeout;

    this.logger.debug(
      `水印请求: position=${request.position}, opacity=${request.opacity}`,
    );

    try {
      const response = await firstValueFrom(
        this.imageService.watermark(request).pipe(
          timeout(effectiveTimeout),
          retry({
            count: this.retryAttempts,
            delay: (_, retryCount) => {
              this.logger.warn(`水印重试 (${retryCount}/${this.retryAttempts})`);
              return timer(this.retryDelay);
            },
          }),
          tap((res) => {
            this.logger.debug(`水印完成: elapsed=${res.elapsedMs}ms`);
          }),
          catchError((error) => this.handleError(error, 'watermark')),
        ),
      );

      return response;
    } catch (error) {
      throw this.transformError(error, 'watermark');
    }
  }

  // =========================================================================
  // 批量处理
  // =========================================================================

  /**
   * 批量处理图像 (流式返回)
   *
   * @param request 批量请求
   * @returns 流式响应 Observable
   */
  batchProcess(request: BatchProcessRequest): Observable<ProcessChunk> {
    this.logger.debug(`批量处理请求: count=${request.images.length}`);

    return this.imageService.batchProcess(request).pipe(
      tap((chunk) => {
        if (chunk.isFinal) {
          this.logger.debug(`批量处理完成: totalCount=${chunk.index + 1}`);
        }
      }),
      catchError((error) => this.handleError(error, 'batchProcess')),
    );
  }

  // =========================================================================
  // 健康检查
  // =========================================================================

  /**
   * 健康检查
   */
  async checkHealth(): Promise<HealthCheckResponse> {
    try {
      return await firstValueFrom(
        this.healthService.check({ service: '' }).pipe(
          timeout(5000),
          catchError((error) => this.handleError(error, 'healthCheck')),
        ),
      );
    } catch (error) {
      throw this.transformError(error, 'healthCheck');
    }
  }

  /**
   * 检查服务是否可用
   */
  async isAvailable(): Promise<boolean> {
    try {
      const health = await this.checkHealth();
      return health.status === 1;
    } catch {
      return false;
    }
  }

  // =========================================================================
  // 错误处理
  // =========================================================================

  private handleError(error: Error, method: string): Observable<never> {
    return throwError(() => this.transformError(error, method));
  }

  private transformError(error: unknown, method: string): Error {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (
      errorMessage.includes('Timeout') ||
      errorMessage.includes('DEADLINE_EXCEEDED')
    ) {
      this.logger.error(`请求超时: method=${method}`);
      return new RequestTimeoutException(`图像处理超时: ${method}`);
    }

    if (
      errorMessage.includes('UNAVAILABLE') ||
      errorMessage.includes('ECONNREFUSED') ||
      errorMessage.includes('Connection')
    ) {
      this.logger.error(`服务不可用: method=${method}, error=${errorMessage}`);
      return new ServiceUnavailableException('图像处理服务暂时不可用');
    }

    this.logger.error(`调用失败: method=${method}, error=${errorMessage}`);
    return new ServiceUnavailableException(`图像处理失败: ${errorMessage}`);
  }
}
