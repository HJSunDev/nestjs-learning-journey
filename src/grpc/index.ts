/**
 * gRPC 模块统一导出
 */
export * from './grpc.module';
export * from './clients';
export * from './constants';

// 接口单独导出，避免与 clients 中的类型冲突
export type {
  // 图像处理
  ImageFormat,
  WatermarkPosition,
  CompressRequest,
  CompressResponse,
  ResizeRequest,
  ResizeResponse,
  WatermarkRequest,
  WatermarkResponse,
  TextWatermark,
  ImageWatermark,
  BatchProcessRequest,
  ProcessChunk,
  IImageServiceClient,
  // 健康检查
  HealthCheckRequest,
  HealthCheckResponse,
  IHealthServiceClient,
} from './interfaces';
