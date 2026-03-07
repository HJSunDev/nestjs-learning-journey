import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { StreamChunk } from '../interfaces';
import { StreamChunkType } from '../constants';

export interface StreamContext {
  label: string;
  provider: string;
  model: string;
}

/**
 * 流式响应适配器
 *
 * 负责将内部的 Observable<StreamChunk> 转换为不同前端期望的 SSE 传输协议。
 * 将这部分逻辑从 Controller 中抽离，遵循单一职责原则 (SRP)。
 */
@Injectable()
export class AiStreamAdapter {
  private readonly logger = new Logger(AiStreamAdapter.name);

  /**
   * 设置通用的 SSE 响应头
   */
  private setSseHeaders(res: Response): void {
    // SSE 标准响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // 禁用 Nginx 缓冲（生产环境反向代理时需要禁用）
    res.setHeader('X-Accel-Buffering', 'no');
  }

  /**
   * 设置原始 SSE 流式响应
   *
   * 输出格式为自定义 JSON（适用于 curl 调试、非 React 前端、ApiPost 测试）。
   */
  pipeStandardStream(
    res: Response,
    stream$: Observable<StreamChunk>,
    context: StreamContext,
  ): void {
    this.setSseHeaders(res);
    this.logger.debug(
      `开始${context.label}: provider=${context.provider}, model=${context.model}`,
    );

    const subscription = stream$.subscribe({
      next: (chunk: StreamChunk) => {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      },
      error: (error: Error) => {
        this.logger.error(`${context.label}错误`, error.stack);
        res.write(
          `data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`,
        );
        res.end();
      },
      complete: () => {
        this.logger.debug(`${context.label}完成`);
        res.write('data: [DONE]\n\n');
        res.end();
      },
    });

    // 客户端断开连接时取消订阅，释放资源
    res.on('close', () => {
      this.logger.debug(`客户端断开连接 (${context.label})`);
      subscription.unsubscribe();
    });
  }

  /**
   * 设置 Vercel AI SDK v6 UIMessageStream 格式的 SSE 响应
   *
   * 将 Observable<StreamChunk> 转换为 UIMessageStream 协议格式。
   * 该协议要求为 text/reasoning 部分维护 start → delta → end 的完整生命周期，
   * 前端 useChat Hook 根据这些事件构建消息的 parts 数组。
   */
  pipeUIMessageStream(
    res: Response,
    stream$: Observable<StreamChunk>,
    context: StreamContext,
  ): void {
    this.setSseHeaders(res);
    this.logger.debug(
      `开始${context.label} (AI SDK): provider=${context.provider}, model=${context.model}`,
    );

    // 跟踪当前活跃的 part ID，用于 start/delta/end 生命周期匹配
    let reasoningPartId: string | null = null;
    let textPartId: string | null = null;
    let partCounter = 0;

    const writeSseEvent = (data: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // UIMessageStream 协议要求的流开始信号
    writeSseEvent({ type: 'start' });
    writeSseEvent({ type: 'start-step' });

    const subscription = stream$.subscribe({
      next: (chunk: StreamChunk) => {
        if (chunk.type === StreamChunkType.REASONING) {
          if (!reasoningPartId) {
            reasoningPartId = `r-${partCounter++}`;
            writeSseEvent({ type: 'reasoning-start', id: reasoningPartId });
          }
          writeSseEvent({
            type: 'reasoning-delta',
            id: reasoningPartId,
            delta: chunk.content ?? '',
          });
        } else if (chunk.type === StreamChunkType.TEXT) {
          // reasoning → text 的阶段转换：先关闭 reasoning 部分
          if (reasoningPartId) {
            writeSseEvent({ type: 'reasoning-end', id: reasoningPartId });
            reasoningPartId = null;
          }
          if (!textPartId) {
            textPartId = `t-${partCounter++}`;
            writeSseEvent({ type: 'text-start', id: textPartId });
          }
          writeSseEvent({
            type: 'text-delta',
            id: textPartId,
            delta: chunk.content ?? '',
          });
        } else if (chunk.type === StreamChunkType.DONE) {
          // 关闭所有未结束的活跃部分
          if (reasoningPartId) {
            writeSseEvent({ type: 'reasoning-end', id: reasoningPartId });
          }
          if (textPartId) {
            writeSseEvent({ type: 'text-end', id: textPartId });
          }
          writeSseEvent({ type: 'finish-step' });
          writeSseEvent({
            type: 'finish',
            finishReason: chunk.finishReason ?? 'stop',
            usage: chunk.usage,
          });
        } else if (chunk.type === StreamChunkType.ERROR) {
          writeSseEvent({
            type: 'error',
            errorText: chunk.error ?? 'Unknown error',
          });
        }
      },
      error: (error: Error) => {
        this.logger.error(`${context.label} (AI SDK) 错误`, error.stack);
        writeSseEvent({ type: 'error', errorText: error.message });
        res.write('data: [DONE]\n\n');
        res.end();
      },
      complete: () => {
        this.logger.debug(`${context.label} (AI SDK) 完成`);
        res.write('data: [DONE]\n\n');
        res.end();
      },
    });

    // 客户端断开连接时取消订阅，释放资源
    res.on('close', () => {
      this.logger.debug(`客户端断开连接 (AI SDK - ${context.label})`);
      subscription.unsubscribe();
    });
  }
}
