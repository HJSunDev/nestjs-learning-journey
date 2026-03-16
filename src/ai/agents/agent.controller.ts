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

import { GraphService } from './graph.service';
import { GraphChatRequestDto, GraphChatResponseDto } from '../dto';
import { AiExceptionFilter } from '../filters/ai-exception.filter';
import { AiStreamAdapter } from '../adapters/stream.adapter';
import { Public } from 'src/common/decorators/public.decorator';

/**
 * Agent 控制器
 *
 * 阶段四（LangGraph 有状态智能体）的独立 HTTP 入口。
 * 路由前缀 'ai/agent'，与阶段二的 /ai/* 和阶段三的 /ai/lcel/* 完全隔离。
 *
 * 职责边界：
 * - /ai/*       → AiController（038 过程式 API）
 * - /ai/lcel/*  → LcelController（041-046 LCEL 管道）
 * - /ai/agent/* → AgentController（047+ LangGraph 图编排）
 *
 * 047 章节端点：
 * - POST /graph/chat           Graph API 非流式工具调用
 * - POST /graph/chat/stream    Graph API 流式工具调用
 * - POST /graph/functional/chat  Functional API 非流式工具调用
 */
@ApiTags('AI 服务 (Agent 智能体)')
@ApiBearerAuth()
@UseFilters(AiExceptionFilter)
@Controller('ai/agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly graphService: GraphService,
    private readonly streamAdapter: AiStreamAdapter,
  ) {}

  // ============================================================
  // 047 LangGraph StateGraph 端点
  // ============================================================

  @Public()
  @Post('graph/chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '图编排对话（Graph API）',
    description:
      '使用 LangGraph StateGraph 实现的工具调用循环。' +
      '与 043 ToolCallingLoop 功能等价，但底层从黑盒 while 循环升级为显式状态图：' +
      'callModel → shouldContinue → executeTools → callModel 循环。' +
      '每个节点可独立观测和中断，为后续持久化（049）和人机协同（050）做准备。',
  })
  @ApiResponse({
    status: 200,
    description: '图编排对话成功',
    type: GraphChatResponseDto,
  })
  async graphChat(
    @Body() dto: GraphChatRequestDto,
  ): Promise<GraphChatResponseDto> {
    this.logger.log(
      `[Graph] 图编排对话，提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    const result = await this.graphService.invokeGraph({
      provider: dto.provider,
      model: dto.model,
      messages: dto.messages,
      systemPrompt: dto.systemPrompt,
      toolNames: dto.tools,
      maxIterations: dto.maxIterations,
      temperature: dto.temperature,
      maxTokens: dto.maxTokens,
    });

    return {
      content: result.content,
      iterationCount: result.iterationCount,
      toolCallCount: result.toolCallCount,
      usage: result.usage,
      trace: result.trace,
    };
  }

  @Public()
  @Post('graph/chat/stream')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '流式图编排对话（Graph API）',
    description:
      '使用 graph.stream("updates") 逐节点推送状态更新。' +
      'callModel 节点的 tool_calls 通过 TOOL_CALL 事件推送，' +
      'executeTools 节点的结果通过 TOOL_RESULT 事件推送，' +
      '最终文本响应通过 TEXT 事件推送。',
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({
    status: 200,
    description: 'SSE 流式响应（含工具调用事件）',
  })
  streamGraphChat(
    @Body() dto: GraphChatRequestDto,
    @Res() res: Response,
  ): void {
    this.logger.log(
      `[Graph] 流式图编排对话，提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    const stream$ = this.graphService.streamGraph({
      provider: dto.provider,
      model: dto.model,
      messages: dto.messages,
      systemPrompt: dto.systemPrompt,
      toolNames: dto.tools,
      maxIterations: dto.maxIterations,
      temperature: dto.temperature,
      maxTokens: dto.maxTokens,
    });

    this.streamAdapter.pipeStandardStream(res, stream$, {
      label: 'Agent图编排对话',
      provider: dto.provider,
      model: dto.model,
    });
  }

  @Public()
  @Post('graph/functional/chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '图编排对话（Functional API）',
    description:
      '使用 LangGraph Functional API (entrypoint + task) 实现的工具调用循环。' +
      '与 Graph API 版本功能等价，展示同一逻辑在过程式范式下的表达。' +
      'task() 将副作用操作封装为可持久化单元，为 049 durable execution 做铺垫。',
  })
  @ApiResponse({
    status: 200,
    description: '函数式图编排对话成功',
    type: GraphChatResponseDto,
  })
  async functionalGraphChat(
    @Body() dto: GraphChatRequestDto,
  ): Promise<GraphChatResponseDto> {
    this.logger.log(
      `[Functional] 函数式图编排对话，提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    const result = await this.graphService.invokeFunctional({
      provider: dto.provider,
      model: dto.model,
      messages: dto.messages,
      systemPrompt: dto.systemPrompt,
      toolNames: dto.tools,
      maxIterations: dto.maxIterations,
      temperature: dto.temperature,
      maxTokens: dto.maxTokens,
    });

    return {
      content: result.content,
      iterationCount: result.iterationCount,
      toolCallCount: result.toolCallCount,
      usage: result.usage,
      trace: result.trace,
    };
  }
}
