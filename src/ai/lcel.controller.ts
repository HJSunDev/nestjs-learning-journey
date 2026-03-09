import {
  Controller,
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
} from './dto';
import { AiExceptionFilter } from './filters/ai-exception.filter';
import { Public } from 'src/common/decorators/public.decorator';
import { AiStreamAdapter } from './adapters/stream.adapter';

/**
 * LCEL 管道控制器 (041 章节专享)
 *
 * 暴露基于声明式管道架构的独立端点，用于与 038 章节的过程式端点 (/ai/*) 对比。
 * 路由前缀设为 'ai/lcel'。
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
}
