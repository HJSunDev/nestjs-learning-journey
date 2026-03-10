import {
  Controller,
  Get,
  Post,
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
}
