import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * LangChain / AI 模型调用异常的统一 HTTP 状态码映射
 *
 * 将上游厂商返回的原始状态码转换为对客户端有意义的 HTTP 状态码：
 * - 401/403：直接透传（认证/权限问题需要调用方感知）
 * - 429：直接透传（限流信号需要客户端做退避）
 * - 400：上游认为请求格式无效
 * - 其他/未知：502 Bad Gateway（表示"我们的上游出了问题"）
 */
const UPSTREAM_STATUS_MAP: Record<number, HttpStatus> = {
  400: HttpStatus.BAD_REQUEST,
  401: HttpStatus.UNAUTHORIZED,
  403: HttpStatus.FORBIDDEN,
  429: HttpStatus.TOO_MANY_REQUESTS,
};

/**
 * AI 模块异常过滤器
 *
 * 职责：拦截 AiController 中所有未被捕获的异常，
 * 从 LangChain 错误对象中提取上游状态码和错误信息，
 * 转换为结构化的 HTTP 响应。
 *
 * 设计决策：
 * - 使用 @Catch() 不带参数，捕获所有异常类型
 *   （LangChain 抛出的不是标准 Error 子类，无法用具体类型匹配）
 * - 挂载在 AiController 上而非全局，避免干扰其他模块的异常处理
 * - Service 层不需要 try-catch，保持纯业务逻辑
 * - NestJS 自身的 HttpException（如 ValidationPipe 抛出的 BadRequestException）
 *   优先走标准路径，保留校验详情；仅对 LangChain 等非标准异常走自定义提取
 */
@Catch()
export class AiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    // NestJS 框架层的 HttpException（ValidationPipe、BadRequestException 等）
    // 走标准处理路径，保留完整的校验错误详情
    if (exception instanceof HttpException) {
      const httpStatus = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      // ValidationPipe 的 getResponse() 返回 { statusCode, message: string[], error }
      const detail =
        typeof exceptionResponse === 'object'
          ? exceptionResponse
          : { message: exceptionResponse };

      this.logger.error(
        `请求校验失败 [${request.method} ${request.url}]: ${exception.message}`,
      );

      response.status(httpStatus).json({
        statusCode: httpStatus,
        timestamp: new Date().toISOString(),
        path: request.url,
        ...detail,
      });
      return;
    }

    // 超时类错误优先检测，映射为 504 Gateway Timeout
    if (this.isTimeoutError(exception)) {
      const message = this.extractMessage(exception);
      this.logger.error(
        `AI 调用超时 [${request.method} ${request.url}]: ${message}`,
      );

      response.status(HttpStatus.GATEWAY_TIMEOUT).json({
        statusCode: HttpStatus.GATEWAY_TIMEOUT,
        timestamp: new Date().toISOString(),
        path: request.url,
        error: 'ai_timeout',
        message,
      });
      return;
    }

    // LangChain 等非标准异常走自定义提取逻辑
    const { status, message, type } = this.extractErrorInfo(exception);
    const httpStatus = UPSTREAM_STATUS_MAP[status] ?? HttpStatus.BAD_GATEWAY;

    this.logger.error(
      `AI 调用失败 [${request.method} ${request.url}]: ${message}`,
    );

    response.status(httpStatus).json({
      statusCode: httpStatus,
      timestamp: new Date().toISOString(),
      path: request.url,
      error: type || 'ai_service_error',
      message,
    });
  }

  /**
   * 从异常对象中提取上游状态码、错误消息和错误类型
   *
   * LangChain 的错误对象结构不固定，需要做防御性提取：
   * - status: 上游 HTTP 状态码（如 401, 429）
   * - message: 人类可读的错误描述
   * - type/lc_error_code: 错误分类标识
   */
  private extractErrorInfo(exception: unknown): {
    status: number;
    message: string;
    type: string;
  } {
    if (typeof exception === 'object' && exception !== null) {
      const err = exception as Record<string, unknown>;
      return {
        status: typeof err.status === 'number' ? err.status : 0,
        message:
          typeof err.message === 'string'
            ? err.message
            : JSON.stringify(exception),
        type:
          typeof err.type === 'string'
            ? err.type
            : typeof err.lc_error_code === 'string'
              ? err.lc_error_code
              : '',
      };
    }

    return {
      status: 0,
      message: String(exception),
      type: '',
    };
  }

  /**
   * 判断异常是否为超时类错误
   *
   * 超时错误有三种来源，需逐一检测：
   * - AbortController.abort() → name === 'AbortError'
   * - Axios HTTP 超时 → code === 'ECONNABORTED' 或 message 含 'timeout'
   * - ToolCallingLoop 包装后的错误 → message 含 '超时'
   */
  private isTimeoutError(exception: unknown): boolean {
    if (!(exception instanceof Error)) return false;

    if (exception.name === 'AbortError') return true;

    const msg = exception.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('超时')) return true;

    const code = (exception as unknown as Record<string, unknown>).code;
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return true;

    return false;
  }

  /**
   * 从异常中提取消息文本
   */
  private extractMessage(exception: unknown): string {
    if (exception instanceof Error) return exception.message;
    return typeof exception === 'string'
      ? exception
      : JSON.stringify(exception);
  }
}
