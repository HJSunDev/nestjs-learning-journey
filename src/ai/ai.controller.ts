import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Res,
  HttpCode,
  HttpStatus,
  Logger,
  UseFilters,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
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
  ModelListResponseDto,
} from './dto';
import { AiExceptionFilter } from './filters/ai-exception.filter';
import { Public } from 'src/common/decorators/public.decorator';
import { AiProvider } from './constants';
import { AiStreamAdapter } from './adapters/stream.adapter';

/**
 * AI 服务控制器
 *
 * 提供 AI 对话相关的 HTTP 端点：
 * - 模型列表查询
 * - 非流式对话（适合 Swagger 调试）
 * - 流式对话（SSE 响应）
 * - 推理对话（含思考过程）
 * - Vercel AI SDK 适配端点（UIMessageStream 协议）
 *
 * @UseFilters(AiExceptionFilter) 将 LangChain 错误转换为结构化 HTTP 响应，
 * Service 层不需要 try-catch，保持纯业务逻辑。
 */
@ApiTags('AI 服务')
@ApiBearerAuth()
@UseFilters(AiExceptionFilter)
@Controller('ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(
    private readonly aiService: AiService,
    private readonly streamAdapter: AiStreamAdapter,
  ) {}

  // ============================================================
  // 模型查询端点
  // ============================================================

  /**
   * 获取可用模型列表
   */
  @Public()
  @Get('models')
  @ApiOperation({
    summary: '获取可用模型列表',
    description: '返回所有已注册的可用模型，支持按提供商筛选',
  })
  @ApiQuery({
    name: 'provider',
    required: false,
    enum: AiProvider,
    description: '按 API 提供商筛选',
  })
  @ApiResponse({
    status: 200,
    description: '模型列表',
    type: ModelListResponseDto,
  })
  getModels(@Query('provider') provider?: AiProvider): ModelListResponseDto {
    return this.aiService.getAvailableModels(provider);
  }

  // ============================================================
  // 对话端点
  // ============================================================

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
  @Public()
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
   * 注意：Swagger UI 无法展示流式响应，请使用 curl 或 ApiPost 等工具测试
   */
  @Public()
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
  streamChat(@Body() dto: ChatRequestDto, @Res() res: Response): void {
    const stream$ = this.aiService.streamChat(dto);
    this.streamAdapter.pipeStandardStream(res, stream$, {
      label: '流式对话',
      provider: dto.provider,
      model: dto.model,
    });
  }

  /**
   * 流式推理对话（SSE）
   *
   * 流式返回思考过程和最终回答
   */
  @Public()
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
  streamReasoningChat(@Body() dto: ChatRequestDto, @Res() res: Response): void {
    const stream$ = this.aiService.streamReasoningChat(dto);
    this.streamAdapter.pipeStandardStream(res, stream$, {
      label: '流式推理对话',
      provider: dto.provider,
      model: dto.model,
    });
  }

  // ============================================================
  // Vercel AI SDK 适配端点（UIMessageStream 协议）
  // ============================================================

  /**
   * 流式对话（Vercel AI SDK v6 协议）
   *
   * 输出 UIMessageStream 格式的 SSE 事件，供前端 useChat Hook 消费。
   *
   * 设计决策：手写协议而非依赖 ai 包的服务端工具函数，
   * 因为 ai 包的服务端 API 在大版本间变动剧烈（v4 createDataStream → v6 createUIMessageStream），
   * 而协议格式本身（JSON-over-SSE）简单且稳定，手写可避免后端被前端包版本绑定。
   */
  @Public()
  @Post('chat/stream/ai-sdk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '流式对话（Vercel AI SDK 协议）',
    description: '输出 UIMessageStream 格式，供前端 useChat Hook 消费',
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({
    status: 200,
    description: 'UIMessageStream SSE 响应',
  })
  streamForVercelAiSdk(
    @Body() dto: ChatRequestDto,
    @Res() res: Response,
  ): void {
    const stream$ = dto.enableReasoning
      ? this.aiService.streamReasoningChat(dto)
      : this.aiService.streamChat(dto);

    this.streamAdapter.pipeUIMessageStream(res, stream$, {
      label: '流式对话',
      provider: dto.provider,
      model: dto.model,
    });
  }
}
