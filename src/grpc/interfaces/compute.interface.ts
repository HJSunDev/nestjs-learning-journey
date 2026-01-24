/**
 * Go 计算服务接口定义
 *
 * 这些类型应与 proto/compute/compute.proto 保持一致
 * 生产环境建议使用 ts-proto 自动生成
 */
import { Observable } from 'rxjs';

// =============================================================================
// 图像处理服务
// =============================================================================

// ----- 枚举 -----

export enum ImageFormat {
  UNKNOWN = 'FORMAT_UNKNOWN',
  JPEG = 'FORMAT_JPEG',
  PNG = 'FORMAT_PNG',
  WEBP = 'FORMAT_WEBP',
  GIF = 'FORMAT_GIF',
}

export enum WatermarkPosition {
  UNKNOWN = 'POSITION_UNKNOWN',
  TOP_LEFT = 'POSITION_TOP_LEFT',
  TOP_RIGHT = 'POSITION_TOP_RIGHT',
  BOTTOM_LEFT = 'POSITION_BOTTOM_LEFT',
  BOTTOM_RIGHT = 'POSITION_BOTTOM_RIGHT',
  CENTER = 'POSITION_CENTER',
}

// ----- 压缩 -----

export interface CompressRequest {
  /** 原始图像数据 (Buffer) */
  imageData: Buffer;
  /** 压缩质量 (1-100) */
  quality: number;
  /** 输出格式 */
  outputFormat?: ImageFormat;
}

export interface CompressResponse {
  imageData: Buffer;
  originalSize: number;
  compressedSize: number;
  compressionRatio: number;
  elapsedMs: number;
}

// ----- 缩放 -----

export interface ResizeRequest {
  imageData: Buffer;
  /** 目标宽度 (0 表示按比例自动计算) */
  width: number;
  /** 目标高度 (0 表示按比例自动计算) */
  height: number;
  /** 是否保持宽高比 */
  keepAspectRatio?: boolean;
  outputFormat?: ImageFormat;
}

export interface ResizeResponse {
  imageData: Buffer;
  originalWidth: number;
  originalHeight: number;
  newWidth: number;
  newHeight: number;
  elapsedMs: number;
}

// ----- 水印 -----

export interface TextWatermark {
  text: string;
  fontSize: number;
  /** 十六进制颜色，如 "#FFFFFF" */
  color: string;
}

export interface ImageWatermark {
  watermarkData: Buffer;
  width: number;
  height: number;
}

export interface WatermarkRequest {
  imageData: Buffer;
  /** 文字水印 (与 image 二选一) */
  text?: TextWatermark;
  /** 图片水印 (与 text 二选一) */
  image?: ImageWatermark;
  position: WatermarkPosition;
  /** 透明度 (0.0-1.0) */
  opacity: number;
}

export interface WatermarkResponse {
  imageData: Buffer;
  elapsedMs: number;
}

// ----- 批量处理 -----

export interface BatchProcessRequest {
  images: Buffer[];
  operation: {
    compress?: Omit<CompressRequest, 'imageData'>;
    resize?: Omit<ResizeRequest, 'imageData'>;
  };
}

export interface ProcessChunk {
  index: number;
  imageData: Buffer;
  success: boolean;
  errorMessage?: string;
  isFinal: boolean;
}

// ----- 服务接口 -----

export interface IImageServiceClient {
  compress(request: CompressRequest): Observable<CompressResponse>;
  resize(request: ResizeRequest): Observable<ResizeResponse>;
  watermark(request: WatermarkRequest): Observable<WatermarkResponse>;
  batchProcess(request: BatchProcessRequest): Observable<ProcessChunk>;
}

// =============================================================================
// 健康检查服务
// =============================================================================

export interface HealthCheckRequest {
  service: string;
}

export interface HealthCheckResponse {
  /** UNKNOWN(0), SERVING(1), NOT_SERVING(2) */
  status: number;
}

export interface IHealthServiceClient {
  check(request: HealthCheckRequest): Observable<HealthCheckResponse>;
}
