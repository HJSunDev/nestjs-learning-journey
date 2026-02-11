import { ExceptionFilter, Catch, ArgumentsHost, HttpException } from '@nestjs/common';
import { Request, Response } from 'express';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const status = exception.getStatus();
    // 获取异常响应
    const exceptionResponse = exception.getResponse();

    // 处理 exceptionResponse，它可能是字符串也可能是对象
    // 默认 NestJS 的 ValidationPipe 抛出的 response 是对象 { statusCode, message, error }
    const errorDetails =
      typeof exceptionResponse === 'string'
        ? { message: exceptionResponse }
        : (exceptionResponse as object);

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      ...errorDetails, // 展开原始错误信息 (message, error 等)
    });
  }
}

