/**
 * gRPC 模块统一导出
 */
export * from './grpc.module';
export * from './clients';
export * from './constants';

// 接口单独导出，避免与 clients 中的类型冲突
export type {
  CalculateRequest,
  CalculateResponse,
  CalculateChunk,
  HealthCheckRequest,
  HealthCheckResponse,
  ComputeServiceClient as IComputeServiceClient,
} from './interfaces';
