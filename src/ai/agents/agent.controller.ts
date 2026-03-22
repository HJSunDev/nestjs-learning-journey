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
  BadRequestException,
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
import { HitlService } from './hitl';
import { ThreadService } from './persistence';
import { AdvancedPatternsService } from './advanced-patterns';
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
  HitlChatRequestDto,
  HitlChatResponseDto,
  HitlResumeRequestDto,
  ReflectionChatRequestDto,
  ReflectionChatResponseDto,
  PlanExecuteChatRequestDto,
  PlanExecuteChatResponseDto,
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
 *
 * 050 章节端点（Human-in-the-Loop）：
 * - POST /hitl/chat                      HITL 对话（首次调用，可能返回 interrupted）
 * - POST /hitl/chat/stream               HITL 流式对话
 * - POST /hitl/resume                    审批恢复执行
 * - POST /hitl/resume/stream             审批恢复流式执行
 *
 * 051 章节端点（Advanced Agent Patterns）：
 * - POST /reflection/chat                Reflection 自我修正对话
 * - POST /plan-execute/chat              Plan-and-Execute 规划执行对话
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
    private readonly hitlService: HitlService,
    private readonly threadService: ThreadService,
    private readonly advancedPatternsService: AdvancedPatternsService,
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

  // ============================================================
  // 050 Human-in-the-Loop 端点
  // ============================================================

  @Public()
  @Post('hitl/chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'HITL 对话 — 人机协同工具审批',
    description:
      '基于 050 Human-in-the-Loop 的 ReAct Agent。' +
      '在 callModel 生成工具调用后、executeTools 执行前，' +
      '通过 interrupt() 暂停执行等待人类审批。' +
      '响应 status="interrupted" 时，需通过 hitl/resume 端点提交审批决策。' +
      'autoApproveTools 中的工具不触发审批，直接执行。',
  })
  @ApiResponse({
    status: 200,
    description: 'HITL 对话结果（completed 或 interrupted）',
    type: HitlChatResponseDto,
  })
  async hitlChat(
    @Body() dto: HitlChatRequestDto,
  ): Promise<HitlChatResponseDto> {
    this.logger.log(
      `[HITL] 对话，线程: ${dto.threadId}, ` +
        `提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    const result = await this.hitlService.invoke(
      {
        provider: dto.provider,
        model: dto.model,
        messages: dto.messages ?? [],
        systemPrompt: dto.systemPrompt,
        toolNames: dto.tools,
        maxIterations: dto.maxIterations,
        temperature: dto.temperature,
        maxTokens: dto.maxTokens,
        autoApproveTools: dto.autoApproveTools,
      },
      {
        threadId: dto.threadId,
        durability: dto.durability,
      },
    );

    return {
      status: result.status,
      threadId: result.threadId,
      content: result.content,
      reasoning: result.reasoning,
      iterationCount: result.iterationCount,
      toolCallCount: result.toolCallCount,
      usage: result.usage,
      trace: result.trace,
      interrupt: result.interrupt,
    };
  }

  @Public()
  @Post('hitl/chat/stream')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'HITL 流式对话',
    description:
      '流式版 HITL 对话。token 级实时推送，' +
      '当 interrupt() 触发时发射 INTERRUPT 事件（含待审批工具调用列表），' +
      '随后发射 DONE 事件。首个事件为 META 类型（含 threadId）。',
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({
    status: 200,
    description: 'SSE 流式响应（含 META/TEXT/TOOL_CALL/INTERRUPT/DONE 事件）',
  })
  streamHitlChat(@Body() dto: HitlChatRequestDto, @Res() res: Response): void {
    this.logger.log(
      `[HITL] 流式对话，线程: ${dto.threadId}, ` +
        `提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    const stream$ = this.hitlService.stream(
      {
        provider: dto.provider,
        model: dto.model,
        messages: dto.messages ?? [],
        systemPrompt: dto.systemPrompt,
        toolNames: dto.tools,
        maxIterations: dto.maxIterations,
        temperature: dto.temperature,
        maxTokens: dto.maxTokens,
        autoApproveTools: dto.autoApproveTools,
      },
      {
        threadId: dto.threadId,
        durability: dto.durability,
      },
    );

    this.streamAdapter.pipeStandardStream(res, stream$, {
      label: 'HITL对话',
      provider: dto.provider,
      model: dto.model,
    });
  }

  @Public()
  @Post('hitl/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'HITL 审批恢复执行',
    description:
      '在 hitl/chat 返回 status="interrupted" 后，审批人通过此端点提交审批决策。' +
      '支持两种审批粒度：decision（批量模式）或 toolDecisions（逐工具模式），二选一。' +
      '恢复后可能再次返回 interrupted（新一轮工具调用需要审批）或 completed。',
  })
  @ApiResponse({
    status: 200,
    description: '恢复执行结果（completed 或 interrupted）',
    type: HitlChatResponseDto,
  })
  async hitlResume(
    @Body() dto: HitlResumeRequestDto,
  ): Promise<HitlChatResponseDto> {
    const resumeValue = this.buildResumeValue(dto);

    this.logger.log(
      `[HITL] 审批恢复，线程: ${dto.threadId}, 模式: ${Array.isArray(resumeValue) ? 'per-tool' : 'batch'}`,
    );

    const result = await this.hitlService.resume(
      {
        threadId: dto.threadId,
        durability: dto.durability,
      },
      resumeValue,
      {
        provider: dto.provider,
        model: dto.model,
        messages: [],
        toolNames: dto.tools,
        maxIterations: dto.maxIterations,
        temperature: dto.temperature,
        maxTokens: dto.maxTokens,
        autoApproveTools: dto.autoApproveTools,
      },
    );

    return {
      status: result.status,
      threadId: result.threadId,
      content: result.content,
      reasoning: result.reasoning,
      iterationCount: result.iterationCount,
      toolCallCount: result.toolCallCount,
      usage: result.usage,
      trace: result.trace,
      interrupt: result.interrupt,
    };
  }

  @Public()
  @Post('hitl/resume/stream')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'HITL 审批恢复流式执行',
    description: '流式版审批恢复。审批决策提交后，后续 token 实时推送。',
  })
  @ApiProduces('text/event-stream')
  @ApiResponse({
    status: 200,
    description: 'SSE 流式响应',
  })
  streamHitlResume(
    @Body() dto: HitlResumeRequestDto,
    @Res() res: Response,
  ): void {
    const resumeValue = this.buildResumeValue(dto);

    this.logger.log(
      `[HITL] 流式审批恢复，线程: ${dto.threadId}, 模式: ${Array.isArray(resumeValue) ? 'per-tool' : 'batch'}`,
    );

    const stream$ = this.hitlService.resumeStream(
      {
        threadId: dto.threadId,
        durability: dto.durability,
      },
      resumeValue,
      {
        provider: dto.provider,
        model: dto.model,
        messages: [],
        toolNames: dto.tools,
        maxIterations: dto.maxIterations,
        temperature: dto.temperature,
        maxTokens: dto.maxTokens,
        autoApproveTools: dto.autoApproveTools,
      },
    );

    this.streamAdapter.pipeStandardStream(res, stream$, {
      label: 'HITL审批恢复',
      provider: dto.provider,
      model: dto.model,
    });
  }

  // ============================================================
  // 051 Advanced Agent Patterns 端点
  // ============================================================

  @Public()
  @Post('reflection/chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reflection 自我修正对话',
    description:
      '基于 051 Reflection 模式的质量门控生成。' +
      'Generator 生成内容后由独立的 Evaluator 评估质量，' +
      '未通过时携带反馈返回 Generator 修正，' +
      '循环直到评估通过或达到最大反思次数。' +
      '支持 Generator 和 Evaluator 使用不同模型（更强模型把关质量）。',
  })
  @ApiResponse({
    status: 200,
    description: 'Reflection 对话成功',
    type: ReflectionChatResponseDto,
  })
  async reflectionChat(
    @Body() dto: ReflectionChatRequestDto,
  ): Promise<ReflectionChatResponseDto> {
    this.logger.log(
      `[Reflection] 自我修正对话，提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    const result = await this.advancedPatternsService.invokeReflection({
      provider: dto.provider,
      model: dto.model,
      messages: dto.messages,
      systemPrompt: dto.systemPrompt,
      evaluationCriteria: dto.evaluationCriteria,
      maxReflections: dto.maxReflections,
      temperature: dto.temperature,
      maxTokens: dto.maxTokens,
      evaluatorModel: dto.evaluatorModel,
      evaluatorProvider: dto.evaluatorProvider,
    });

    return {
      content: result.content,
      reflectionCount: result.reflectionCount,
      score: result.score,
      feedback: result.feedback,
      passed: result.passed,
      usage: result.usage,
      trace: result.trace,
    };
  }

  @Public()
  @Post('plan-execute/chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Plan-and-Execute 规划执行对话',
    description:
      '基于 051 Plan-Execute 模式的复杂任务处理。' +
      'Planner 将用户目标分解为步骤列表，' +
      'Executor 逐步执行（通过 tool-graph 子图使用工具），' +
      'Replanner 在每步完成后审视进度，支持动态调整计划。' +
      '子图组合：Executor 在节点内部调用 tool-graph 作为子图。',
  })
  @ApiResponse({
    status: 200,
    description: 'Plan-Execute 对话成功',
    type: PlanExecuteChatResponseDto,
  })
  async planExecuteChat(
    @Body() dto: PlanExecuteChatRequestDto,
  ): Promise<PlanExecuteChatResponseDto> {
    this.logger.log(
      `[PlanExecute] 规划执行对话，提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    const result = await this.advancedPatternsService.invokePlanExecute({
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
      plan: result.plan,
      stepResults: result.stepResults,
      usage: result.usage,
      trace: result.trace,
    };
  }

  // ============================================================
  // Private Helpers
  // ============================================================

  /**
   * 从 DTO 构建 resume 值 — 批量模式或逐工具模式
   *
   * @throws {BadRequestException} 当 decision 和 toolDecisions 同时缺失时
   */
  private buildResumeValue(dto: HitlResumeRequestDto) {
    if (dto.toolDecisions?.length) {
      return dto.toolDecisions;
    }
    if (dto.decision) {
      return dto.decision;
    }
    throw new BadRequestException('decision 或 toolDecisions 必须提供其中之一');
  }
}
