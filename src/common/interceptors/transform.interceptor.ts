import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Response } from 'express';

/**
 * 标准化 API 响应结构
 *
 * 所有成功响应统一包装为 { statusCode, message, data, timestamp }，
 * 与 HttpExceptionFilter 的错误响应格式对齐，
 * 使前端可以通过 statusCode 统一判断请求结果。
 *
 * 不影响的场景：
 * - 使用 @Res() 手动控制响应的端点（如 SSE 流式输出），NestJS 会自动跳过拦截器管道
 * - 非 HTTP 上下文（gRPC、WebSocket 等）
 */
@Injectable()
export class TransformInterceptor implements NestInterceptor {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<StandardResponse> {
    if (context.getType() !== 'http') {
      return next.handle() as Observable<StandardResponse>;
    }

    const response = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((data: unknown) => ({
        statusCode: response.statusCode,
        message: 'success',
        data,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}

/**
 * 统一响应结构（供外部类型引用）
 */
export interface StandardResponse<T = unknown> {
  statusCode: number;
  message: string;
  data: T;
  timestamp: string;
}
