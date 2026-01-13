/**
 * 计算服务接口定义
 *
 * 这些类型应与 proto/compute/compute.proto 保持一致
 * 生产环境建议使用 ts-proto 自动生成
 */
import { Observable } from 'rxjs';

// ===== 请求/响应消息类型 =====

/**
 * 计算请求
 */
export interface CalculateRequest {
  /** 任务唯一标识 */
  taskId: string;
  /** 任务类型 (如: 'image_process', 'data_analysis') */
  taskType: string;
  /** 任务负载数据 (JSON 字符串或二进制 base64) */
  payload: string;
  /** 元数据键值对 */
  metadata?: Record<string, string>;
}

/**
 * 计算响应
 */
export interface CalculateResponse {
  /** 任务唯一标识 */
  taskId: string;
  /** 任务状态: 'success' | 'failed' | 'timeout' */
  status: string;
  /** 结果数据 */
  result: string;
  /** 执行耗时 (毫秒) */
  elapsedMs: number;
  /** 错误信息 (失败时填充) */
  errorMessage?: string;
}

/**
 * 流式响应块
 */
export interface CalculateChunk {
  /** 任务唯一标识 */
  taskId: string;
  /** 数据块内容 */
  chunk: string;
  /** 当前块序号 */
  index: number;
  /** 是否为最后一块 */
  isFinal: boolean;
}

/**
 * 健康检查请求
 */
export interface HealthCheckRequest {
  /** 要检查的服务名 (空字符串表示检查整体) */
  service: string;
}

/**
 * 健康检查响应
 */
export interface HealthCheckResponse {
  /** 服务状态: UNKNOWN(0), SERVING(1), NOT_SERVING(2) */
  status: number;
}

// ===== 服务接口 =====

/**
 * 计算服务 gRPC 接口
 * 对应 proto 文件中的 service ComputeService
 */
export interface ComputeServiceClient {
  /**
   * 同步计算 - 发送请求并等待完整响应
   */
  calculate(request: CalculateRequest): Observable<CalculateResponse>;

  /**
   * 流式计算 - 发送请求并接收流式响应
   * 适用于大数据处理、AI 推理等场景
   */
  streamCalculate(request: CalculateRequest): Observable<CalculateChunk>;

  /**
   * 健康检查
   */
  healthCheck(request: HealthCheckRequest): Observable<HealthCheckResponse>;
}
