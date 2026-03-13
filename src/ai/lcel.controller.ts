import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
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
  ApiBearerAuth,
  ApiProduces,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { LcelService } from './lcel.service';
import {
  ChatRequestDto,
  QuickChatRequestDto,
  ChatResponseDto,
  ReasoningResponseDto,
  StructuredChatRequestDto,
  StructuredExtractRequestDto,
  StructuredResponseDto,
  ToolCallingChatRequestDto,
  ToolCallingResponseDto,
  MemoryChatRequestDto,
  MemoryChatResponseDto,
  SessionHistoryResponseDto,
  SessionListResponseDto,
  ClearSessionResponseDto,
} from './dto';
import { AiExceptionFilter } from './filters/ai-exception.filter';
import { Public } from 'src/common/decorators/public.decorator';
import { AiStreamAdapter } from './adapters/stream.adapter';

/**
 * LCEL 管道控制器
 *
 * 暴露基于声明式管道架构的独立端点，用于与 038 章节的过程式端点 (/ai/*) 对比。
 * 路由前缀设为 'ai/lcel'。
 *
 * 042 章节扩展：新增 /structured/* 端点，支持通过 withStructuredOutput 获取强类型 JSON 输出。
 * 043 章节扩展：新增 /tool-calling/* 端点，支持 Agentic 工具调用循环。
 * 044 章节扩展：新增 /memory/* 端点，支持基于 Redis 的有状态多轮会话管理。
 */
@ApiTags('AI 服务 (LCEL 管道版)')
@ApiBearerAuth()
@UseFilters(AiExceptionFilter)
@Controller('ai/lcel')
export class LcelController {
  private readonly logger = new Logger(LcelController.name);

  constructor(
    private readonly lcelService: LcelService,
    private readonly streamAdapter: AiStreamAdapter,
  ) {}

  @Public()
  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '标准对话（LCEL 管道版）',
    description: '内部采用 ChatPromptTemplate.pipe(model) 声明式管道架构。',
  })
  @ApiResponse({
    status: 200,
    description: '对话成功',
    type: ChatResponseDto,
  })
  async chat(@Body() dto: ChatRequestDto): Promise<ChatResponseDto> {
    return this.lcelService.chat(dto);
  }

  @Public()
  @Post('chat/quick')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '快速对话（LCEL 管道版）',
    description:
      '内部使用 {input} 模板变量直接接收文本，避免手动拼接消息列表。',
  })
  @ApiResponse({
    status: 200,
    description: '对话成功',
    type: ChatResponseDto,
  })
  async quickChat(@Body() dto: QuickChatRequestDto): Promise<ChatResponseDto> {
    return this.lcelService.quickChat(dto);
  }

  @Public()
  @Post('chat/reasoning')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '推理对话（LCEL 管道版）',
    description: '使用推理模型，返回完整的思考过程和最终答案。',
  })
  @ApiResponse({
    status: 200,
    description: '对话成功',
    type: ReasoningResponseDto,
  })
  async reasoningChat(
    @Body() dto: ChatRequestDto,
  ): Promise<ReasoningResponseDto> {
    return this.lcelService.reasoningChat(dto);
  }

  @Public()
  @Post('chat/stream')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '流式对话（LCEL 管道版）',
    description:
      '与非流式调用共享同一个 prompt.pipe(model) 实例，仅通过 .stream() 触发。',
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({
    status: 200,
    description: 'SSE 流式响应',
  })
  streamChat(@Body() dto: ChatRequestDto, @Res() res: Response): void {
    const stream$ = this.lcelService.streamChat(dto);
    this.streamAdapter.pipeStandardStream(res, stream$, {
      label: 'LCEL流式对话',
      provider: dto.provider,
      model: dto.model,
    });
  }

  @Public()
  @Post('chat/stream/reasoning')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '流式推理对话（LCEL 管道版）',
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({
    status: 200,
    description: 'SSE 流式响应（含推理过程）',
  })
  streamReasoningChat(@Body() dto: ChatRequestDto, @Res() res: Response): void {
    const stream$ = this.lcelService.streamReasoningChat(dto);
    this.streamAdapter.pipeStandardStream(res, stream$, {
      label: 'LCEL流式推理对话',
      provider: dto.provider,
      model: dto.model,
    });
  }

  // ============================================================
  // 042 结构化输出端点
  // ============================================================

  @Public()
  @Get('structured/schemas')
  @ApiOperation({
    summary: '获取可用的结构化输出 Schema 列表',
    description:
      '返回所有预定义的 Zod Schema 名称、描述和字段信息，' +
      '客户端据此选择 schemaName 发起结构化输出请求。',
  })
  @ApiResponse({
    status: 200,
    description: '可用 Schema 列表',
  })
  getAvailableSchemas() {
    return this.lcelService.getAvailableSchemas();
  }

  @Public()
  @Post('structured/chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '多轮对话 + 结构化输出',
    description:
      '通过 model.withStructuredOutput(schema) 将模型输出约束为指定 Schema 的 JSON 对象。' +
      '内部使用 tool calling 机制实现，返回经 Zod 校验的强类型数据。',
  })
  @ApiResponse({
    status: 200,
    description: '结构化输出成功',
    type: StructuredResponseDto,
  })
  async structuredChat(
    @Body() dto: StructuredChatRequestDto,
  ): Promise<StructuredResponseDto> {
    return this.lcelService.structuredChat(dto);
  }

  @Public()
  @Post('structured/extract')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '单轮快速提取 + 结构化输出',
    description:
      '从文本中直接提取结构化信息（如情感分析、实体提取）。' +
      '无需构建消息列表，直接传入文本和 Schema 名称即可。',
  })
  @ApiResponse({
    status: 200,
    description: '结构化提取成功',
    type: StructuredResponseDto,
  })
  async structuredExtract(
    @Body() dto: StructuredExtractRequestDto,
  ): Promise<StructuredResponseDto> {
    return this.lcelService.structuredExtract(dto);
  }

  // ============================================================
  // 043 工具调用端点
  // ============================================================

  @Public()
  @Get('tools')
  @ApiOperation({
    summary: '获取可用的工具列表',
    description:
      '返回所有已注册的工具名称和描述。' +
      '客户端据此选择在 tool-calling 请求中启用哪些工具。',
  })
  @ApiResponse({
    status: 200,
    description: '可用工具列表',
  })
  getAvailableTools() {
    return this.lcelService.getAvailableTools();
  }

  @Public()
  @Post('tool-calling/chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '工具调用对话（Agentic Loop）',
    description:
      '模型自主决定是否调用工具。内部实现 Agentic Loop：' +
      'model.bindTools → invoke → 检查 tool_calls → 执行工具 → 回传结果 → 再次推理，' +
      '循环直到模型生成最终文本响应或达到最大轮次。',
  })
  @ApiResponse({
    status: 200,
    description: '工具调用对话成功',
    type: ToolCallingResponseDto,
  })
  async toolCallingChat(
    @Body() dto: ToolCallingChatRequestDto,
  ): Promise<ToolCallingResponseDto> {
    return this.lcelService.toolChat(dto);
  }

  @Public()
  @Post('tool-calling/chat/stream')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '流式工具调用对话',
    description:
      '与非流式版本相同的 Agentic Loop，区别在于：' +
      '工具调用轮次通过 TOOL_CALL/TOOL_RESULT 事件实时推送，' +
      '最终文本响应通过 TEXT 事件逐 chunk 输出。',
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({
    status: 200,
    description: 'SSE 流式响应（含工具调用事件）',
  })
  streamToolCallingChat(
    @Body() dto: ToolCallingChatRequestDto,
    @Res() res: Response,
  ): void {
    const stream$ = this.lcelService.streamToolChat(dto);
    this.streamAdapter.pipeStandardStream(res, stream$, {
      label: 'LCEL工具调用对话',
      provider: dto.provider,
      model: dto.model,
    });
  }

  // ============================================================
  // 044 有状态会话（Memory）端点
  // ============================================================

  @Public()
  @Post('memory/chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '有状态会话对话',
    description:
      '基于 sessionId 的有状态对话。服务端自动从 Redis 加载历史、推理、持久化新消息。' +
      '客户端只需发送当前轮次的文本，无需维护消息列表。',
  })
  @ApiResponse({
    status: 200,
    description: '对话成功',
    type: MemoryChatResponseDto,
  })
  async memoryChat(
    @Body() dto: MemoryChatRequestDto,
  ): Promise<MemoryChatResponseDto> {
    return this.lcelService.memoryChat(dto);
  }

  @Public()
  @Post('memory/chat/stream')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '流式有状态会话对话',
    description:
      '与非流式版本相同的有状态会话机制，区别在于通过 SSE 逐 chunk 输出。' +
      '流结束后自动将完整响应持久化到 Redis。',
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({
    status: 200,
    description: 'SSE 流式响应',
  })
  streamMemoryChat(
    @Body() dto: MemoryChatRequestDto,
    @Res() res: Response,
  ): void {
    const stream$ = this.lcelService.streamMemoryChat(dto);
    this.streamAdapter.pipeStandardStream(res, stream$, {
      label: 'LCEL有状态对话',
      provider: dto.provider,
      model: dto.model,
    });
  }

  @Public()
  @Get('memory/sessions')
  @ApiOperation({
    summary: '列出所有活跃会话',
    description: '通过 Redis SCAN 遍历所有会话 Key，返回会话元信息列表。',
  })
  @ApiResponse({
    status: 200,
    description: '会话列表',
    type: SessionListResponseDto,
  })
  async listSessions(): Promise<SessionListResponseDto> {
    return this.lcelService.listSessions();
  }

  @Public()
  @Get('memory/sessions/:sessionId')
  @ApiOperation({
    summary: '获取指定会话的历史消息',
    description: '返回指定 sessionId 的完整消息列表和元信息。',
  })
  @ApiResponse({
    status: 200,
    description: '会话历史',
    type: SessionHistoryResponseDto,
  })
  async getSessionHistory(
    @Param('sessionId') sessionId: string,
  ): Promise<SessionHistoryResponseDto> {
    return this.lcelService.getSessionHistory(sessionId);
  }

  @Public()
  @Delete('memory/sessions/:sessionId')
  @ApiOperation({
    summary: '清除指定会话的历史',
    description: '删除指定 sessionId 的全部对话记录。会话不存在时返回 404。',
  })
  @ApiResponse({
    status: 200,
    description: '会话已清除',
    type: ClearSessionResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: '会话不存在',
  })
  async clearSession(
    @Param('sessionId') sessionId: string,
  ): Promise<ClearSessionResponseDto> {
    return this.lcelService.clearSession(sessionId);
  }
}
