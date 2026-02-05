import {
  Controller,
  Post,
  Body,
  Res,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiProduces,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { AiService } from './ai.service';
import {
  ChatRequestDto,
  QuickChatRequestDto,
  ChatResponseDto,
  ReasoningResponseDto,
} from './dto';
import { StreamChunk } from './interfaces';
import { Public } from 'src/common/decorators/public.decorator';

/**
 * AI 服务控制器
 *
 * 提供 AI 对话相关的 HTTP 端点：
 * - 非流式对话（适合 Swagger 调试）
 * - 流式对话（SSE 响应）
 * - 推理对话（含思考过程）
 */
@ApiTags('AI 服务')
@ApiBearerAuth()
@Controller('ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(private readonly aiService: AiService) {}

  /**
   * 标准对话（非流式）
   */
  @Public()
  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '标准对话（非流式）',
    description: '发送消息并获取完整响应，支持多轮对话',
  })
  @ApiResponse({
    status: 200,
    description: '对话成功',
    type: ChatResponseDto,
  })
  async chat(@Body() dto: ChatRequestDto): Promise<ChatResponseDto> {
    return this.aiService.chat(dto);
  }

  /**
   * 快速对话（单轮）
   */
  @Post('chat/quick')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '快速对话（单轮）',
    description: '简化的单轮对话接口，无需构建消息列表',
  })
  @ApiResponse({
    status: 200,
    description: '对话成功',
    type: ChatResponseDto,
  })
  async quickChat(@Body() dto: QuickChatRequestDto): Promise<ChatResponseDto> {
    return this.aiService.quickChat(dto);
  }

  /**
   * 推理对话（含思考过程）
   */
  @Post('chat/reasoning')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '推理对话（含思考过程）',
    description: '使用推理模型，返回完整的思考过程和最终答案',
  })
  @ApiResponse({
    status: 200,
    description: '对话成功',
    type: ReasoningResponseDto,
  })
  async reasoningChat(
    @Body() dto: ChatRequestDto,
  ): Promise<ReasoningResponseDto> {
    return this.aiService.reasoningChat(dto);
  }

  // ============================================================
  // 流式端点（SSE）
  // ============================================================

  /**
   * 流式对话（SSE）
   *
   * 使用 Server-Sent Events 实时推送 AI 响应
   * 注意：Swagger UI 无法展示流式响应，请使用 curl 或前端代码测试
   *
   * @example curl 测试命令
   * ```bash
   * curl -N -X POST http://localhost:3000/ai/chat/stream \
   *   -H "Content-Type: application/json" \
   *   -H "Authorization: Bearer <token>" \
   *   -d '{"provider":"deepseek","model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'
   * ```
   */
  @Post('chat/stream')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '流式对话（SSE）',
    description: `使用 Server-Sent Events 实时推送 AI 响应。
    
**注意**：Swagger UI 无法展示流式响应，请使用 curl 或前端代码测试。

**响应格式**：每行为一个 SSE 事件，格式为 \`data: {json}\`

**事件类型**：
- \`reasoning\`: 推理/思考过程
- \`text\`: 正式文本内容
- \`tool_call\`: 工具调用
- \`done\`: 流结束
- \`error\`: 错误信息`,
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({
    status: 200,
    description: 'SSE 流式响应',
  })
  streamChat(
    @Body() dto: ChatRequestDto,
    @Res() res: Response,
  ): void {
    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    // 禁用 Nginx 缓冲（生产环境反向代理时需要）
    res.setHeader('X-Accel-Buffering', 'no');

    this.logger.debug(
      `开始流式对话: provider=${dto.provider}, model=${dto.model}`,
    );

    // 获取流式 Observable 并订阅
    const stream$ = this.aiService.streamChat(dto);

    const subscription = stream$.subscribe({
      next: (chunk: StreamChunk) => {
        // 按 SSE 规范格式化输出
        const data = JSON.stringify(chunk);
        res.write(`data: ${data}\n\n`);
      },
      error: (error: Error) => {
        this.logger.error('流式对话错误', error.stack);
        const errorChunk = JSON.stringify({
          type: 'error',
          error: error.message,
        });
        res.write(`data: ${errorChunk}\n\n`);
        res.end();
      },
      complete: () => {
        this.logger.debug('流式对话完成');
        res.write('data: [DONE]\n\n');
        res.end();
      },
    });

    // 处理客户端断开连接
    res.on('close', () => {
      this.logger.debug('客户端断开连接');
      subscription.unsubscribe();
    });
  }

  /**
   * 流式推理对话（SSE）
   *
   * 流式返回思考过程和最终回答
   */
  @Post('chat/stream/reasoning')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '流式推理对话（SSE）',
    description: '流式返回推理过程和最终回答，适合展示 AI 的思考过程',
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({
    status: 200,
    description: 'SSE 流式响应（含推理过程）',
  })
  streamReasoningChat(
    @Body() dto: ChatRequestDto,
    @Res() res: Response,
  ): void {
    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    this.logger.debug(
      `开始流式推理对话: provider=${dto.provider}, model=${dto.model}`,
    );

    const stream$ = this.aiService.streamReasoningChat(dto);

    const subscription = stream$.subscribe({
      next: (chunk: StreamChunk) => {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      },
      error: (error: Error) => {
        this.logger.error('流式推理对话错误', error.stack);
        res.write(
          `data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`,
        );
        res.end();
      },
      complete: () => {
        res.write('data: [DONE]\n\n');
        res.end();
      },
    });

    res.on('close', () => {
      this.logger.debug('客户端断开连接');
      subscription.unsubscribe();
    });
  }
}
