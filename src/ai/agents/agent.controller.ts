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
import { ReactService } from './react.service';
import {
  GraphChatRequestDto,
  GraphChatResponseDto,
  ReactChatRequestDto,
  ReactChatResponseDto,
} from '../dto';
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
 *
 * 048 章节端点：
 * - POST /react/chat           ReAct Agent 非流式对话
 * - POST /react/chat/stream    ReAct Agent 流式对话
 */
@ApiTags('AI 服务 (Agent 智能体)')
@ApiBearerAuth()
@UseFilters(AiExceptionFilter)
@Controller('ai/agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly graphService: GraphService,
    private readonly reactService: ReactService,
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

  // ============================================================
  // 048 ReAct Agent 端点
  // ============================================================

  @Public()
  @Post('react/chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'ReAct Agent 对话',
    description:
      '生产级 ReAct（Reasoning + Acting）智能体。' +
      '内置 ReAct 系统提示词引导 Thought → Action → Observation 循环；' +
      '输入安全守卫（Prompt Injection 检测 + 消息数量/长度限制）。' +
      '相比 047 的原始图编排，048 增加了 Agent 级提示词工程和安全防护层。',
  })
  @ApiResponse({
    status: 200,
    description: 'ReAct Agent 对话成功',
    type: ReactChatResponseDto,
  })
  async reactChat(
    @Body() dto: ReactChatRequestDto,
  ): Promise<ReactChatResponseDto> {
    this.logger.log(
      `[ReAct] 对话，提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    const result = await this.reactService.invoke({
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
  @Post('react/chat/stream')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '流式 ReAct Agent 对话',
    description:
      '流式版 ReAct Agent。' +
      'token 级实时推送（TEXT），工具调用事件（TOOL_CALL / TOOL_RESULT）。',
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({
    status: 200,
    description: 'SSE 流式响应',
  })
  streamReactChat(
    @Body() dto: ReactChatRequestDto,
    @Res() res: Response,
  ): void {
    this.logger.log(
      `[ReAct] 流式对话，提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    const stream$ = this.reactService.stream({
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
      label: 'ReAct Agent对话',
      provider: dto.provider,
      model: dto.model,
    });
  }
}
