import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Res,
  HttpCode,
  HttpStatus,
  Logger,
  UseFilters,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiProduces,
  ApiParam,
} from '@nestjs/swagger';
import type { Response } from 'express';

import { GraphService } from './graph.service';
import { ReactService } from './react.service';
import { ThreadService } from './persistence';
import {
  GraphChatRequestDto,
  GraphChatResponseDto,
  ReactChatRequestDto,
  ReactChatResponseDto,
  ThreadChatRequestDto,
  ThreadChatResponseDto,
  ThreadStateResponseDto,
  ThreadHistoryQueryDto,
  ThreadForkRequestDto,
  ThreadForkResponseDto,
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
 *
 * 049 章节端点（Durable Execution & Thread Lifecycle）：
 * - POST /thread/chat                    线程感知的持久化非流式对话
 * - POST /thread/chat/stream             线程感知的持久化流式对话
 * - GET  /thread/:threadId/state         获取线程当前状态
 * - GET  /thread/:threadId/history       获取线程 checkpoint 历史
 * - POST /thread/:threadId/fork          从历史 checkpoint 分叉
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
    private readonly threadService: ThreadService,
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
      reasoning: result.reasoning,
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

  // ============================================================
  // 049 Durable Execution & Thread Lifecycle 端点
  // ============================================================

  @Public()
  @Post('thread/chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '线程感知的持久化对话（Durable Execution）',
    description:
      '基于 049 Durable Execution 的 ReAct Agent。' +
      '通过 threadId 标识执行上下文，每个 super-step 边界自动保存 checkpoint。' +
      '支持断点续传（messages 为空时从上次中断点恢复）、错误恢复和跨请求状态保持。' +
      '持久化模式：sync（同步，最可靠）、async（异步，高性能）、exit（仅退出时写入）。',
  })
  @ApiResponse({
    status: 200,
    description: '持久化对话成功',
    type: ThreadChatResponseDto,
  })
  async threadChat(
    @Body() dto: ThreadChatRequestDto,
  ): Promise<ThreadChatResponseDto> {
    this.logger.log(
      `[Thread] 持久化对话，线程: ${dto.threadId}, ` +
        `提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    const result = await this.reactService.invokeWithThread(
      {
        provider: dto.provider,
        model: dto.model,
        messages: dto.messages ?? [],
        systemPrompt: dto.systemPrompt,
        toolNames: dto.tools,
        maxIterations: dto.maxIterations,
        temperature: dto.temperature,
        maxTokens: dto.maxTokens,
      },
      {
        threadId: dto.threadId,
        durability: dto.durability,
      },
    );

    return {
      content: result.content,
      threadId: result.threadId ?? dto.threadId,
      reasoning: result.reasoning,
      iterationCount: result.iterationCount,
      toolCallCount: result.toolCallCount,
      usage: result.usage,
      trace: result.trace,
    };
  }

  @Public()
  @Post('thread/chat/stream')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '线程感知的持久化流式对话',
    description:
      '流式版 Durable Execution。token 级实时推送，同时每个 super-step 保存 checkpoint。' +
      '首个事件为 META 类型，包含 threadId。',
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({
    status: 200,
    description: 'SSE 流式响应（含 META/TEXT/TOOL_CALL/TOOL_RESULT 事件）',
  })
  streamThreadChat(
    @Body() dto: ThreadChatRequestDto,
    @Res() res: Response,
  ): void {
    this.logger.log(
      `[Thread] 流式持久化对话，线程: ${dto.threadId}, ` +
        `提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    const stream$ = this.reactService.streamWithThread(
      {
        provider: dto.provider,
        model: dto.model,
        messages: dto.messages ?? [],
        systemPrompt: dto.systemPrompt,
        toolNames: dto.tools,
        maxIterations: dto.maxIterations,
        temperature: dto.temperature,
        maxTokens: dto.maxTokens,
      },
      {
        threadId: dto.threadId,
        durability: dto.durability,
      },
    );

    this.streamAdapter.pipeStandardStream(res, stream$, {
      label: 'Thread持久化对话',
      provider: dto.provider,
      model: dto.model,
    });
  }

  @Public()
  @Get('thread/:threadId/state')
  @ApiOperation({
    summary: '获取线程当前状态',
    description:
      '读取指定线程的最新 checkpoint，返回完整的状态快照。' +
      '包含消息历史、工具调用计数、迭代次数、待执行节点等信息。',
  })
  @ApiParam({ name: 'threadId', description: '线程 ID（UUID v4）' })
  @ApiResponse({
    status: 200,
    description: '线程当前状态',
    type: ThreadStateResponseDto,
  })
  async getThreadState(
    @Param('threadId', new ParseUUIDPipe({ version: '4' })) threadId: string,
  ): Promise<ThreadStateResponseDto> {
    this.logger.log(`[Thread] 获取线程状态: ${threadId}`);

    const graph = this.reactService.getDurableGraph();
    return this.threadService.getState(threadId, graph);
  }

  @Public()
  @Get('thread/:threadId/history')
  @ApiOperation({
    summary: '获取线程 checkpoint 历史',
    description:
      '返回按时间倒序排列的 checkpoint 列表。' +
      '每个 checkpoint 对应一个 super-step 边界的状态快照，可用于 Time-travel 调试。',
  })
  @ApiParam({ name: 'threadId', description: '线程 ID（UUID v4）' })
  @ApiResponse({
    status: 200,
    description: 'Checkpoint 历史列表（最新在前）',
    type: [ThreadStateResponseDto],
  })
  async getThreadHistory(
    @Param('threadId', new ParseUUIDPipe({ version: '4' })) threadId: string,
    @Query() query: ThreadHistoryQueryDto,
  ): Promise<ThreadStateResponseDto[]> {
    this.logger.log(
      `[Thread] 获取线程历史: ${threadId}, limit: ${query.limit ?? 20}`,
    );

    const graph = this.reactService.getDurableGraph();
    return this.threadService.getStateHistory(threadId, graph, query.limit);
  }

  @Public()
  @Post('thread/:threadId/fork')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '从历史 checkpoint 分叉（Time-travel）',
    description:
      'Time-travel 核心操作：在指定的历史 checkpoint 上创建新分支。' +
      '分叉后可通过 thread/chat 端点从分叉点继续执行，探索不同的执行路径。' +
      '原始执行历史不受影响。',
  })
  @ApiParam({ name: 'threadId', description: '线程 ID（UUID v4）' })
  @ApiResponse({
    status: 200,
    description: '分叉成功，返回新 checkpoint 配置',
    type: ThreadForkResponseDto,
  })
  async forkThread(
    @Param('threadId', new ParseUUIDPipe({ version: '4' })) threadId: string,
    @Body() dto: ThreadForkRequestDto,
  ): Promise<ThreadForkResponseDto> {
    this.logger.log(
      `[Thread] 分叉线程: ${threadId}, checkpoint: ${dto.checkpointId}`,
    );

    const graph = this.reactService.getDurableGraph();
    const result = await this.threadService.fork(
      threadId,
      dto.checkpointId,
      graph,
      undefined,
      dto.asNode,
    );

    return {
      success: true,
      configurable: result.configurable,
      message: `已从 checkpoint ${dto.checkpointId} 创建分叉，可通过 thread/chat 端点继续执行`,
    };
  }
}
