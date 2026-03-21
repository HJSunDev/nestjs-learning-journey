import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AIMessage,
  AIMessageChunk,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import { Observable, type Subscriber } from 'rxjs';

import { AiModelFactory } from '../../factories/model.factory';
import { ToolRegistry } from '../../tools/tool.registry';
import { ReasoningNormalizer } from '../../normalizers/reasoning.normalizer';
import { LangChainTracer } from '../../observability';
import { AiProvider, StreamChunkType } from '../../constants';
import { MODEL_REGISTRY } from '../../constants/model-registry';
import type { StreamChunk, Message } from '../../interfaces';
import { convertToLangChainMessages } from '../../utils';

import {
  buildHitlToolGraph,
  type HitlGraphCompiled,
} from '../single/hitl-graph';
import type { HitlGraphContext } from '../single/hitl-graph';
import { buildReactPrompt } from '../single/react-agent/react-agent.prompts';
import { validateInput } from '../shared/guards';
import { CheckpointService } from '../persistence';

import type {
  HitlInvokeResult,
  HitlResumeValue,
  InterruptEntry,
} from './hitl.types';

/**
 * HITL 调用参数
 */
export interface HitlInvokeParams {
  provider: string;
  model: string;
  messages: Message[];
  systemPrompt?: string;
  toolNames?: string[];
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  /** 免审批工具列表 */
  autoApproveTools?: string[];
}

/**
 * HITL 线程配置
 */
export interface HitlThreadConfig {
  threadId: string;
  durability?: 'sync' | 'async' | 'exit';
}

// 持久化图的运行时类型桥接（与 ReactService 同理）
type HitlGraphInput = { messages: BaseMessage[] } | null;

type HitlGraphResult = Record<string, unknown> & {
  __interrupt__?: InterruptEntry[];
};

type HitlGraphStreamChunk = [string, unknown];

type HitlGraphStream = AsyncIterable<HitlGraphStreamChunk>;

interface HitlGraphInvokeOptions {
  context: HitlGraphContext;
  callbacks: LangChainTracer[];
  configurable: { thread_id: string };
  durability: 'sync' | 'async' | 'exit';
}

interface HitlGraphStreamOptions extends HitlGraphInvokeOptions {
  streamMode: ['messages', 'updates'];
  signal: AbortSignal;
}

interface HitlRuntimeGraph {
  invoke(
    input: HitlGraphInput | Command,
    options: HitlGraphInvokeOptions,
  ): Promise<HitlGraphResult>;
  stream(
    input: HitlGraphInput | Command,
    options: HitlGraphStreamOptions,
  ): Promise<HitlGraphStream>;
  getState(config: {
    configurable: { thread_id: string };
  }): Promise<{ next?: string[]; values?: Record<string, unknown> }>;
}

/**
 * HITL Service — 人机协同智能体服务
 *
 * 在 049 Durable Execution 基础上，实现"工具调用前人类审批"的完整生命周期：
 *
 * 1. invoke()  — 首次调用，模型推理后在 reviewToolCalls 节点触发 interrupt()，
 *                返回 { status: 'interrupted', interrupt: {...} } 等待审批
 * 2. resume()  — 审批人提交决策后恢复执行，
 *                通过 Command({ resume: decision }) 传递审批结果
 * 3. stream() / resumeStream() — 上述流程的 SSE 流式版本
 *
 * 架构决策：
 * - HITL 图复用 047 的 callModel/executeTools/shouldContinue 共享节点
 * - 审批逻辑集中在 reviewToolCalls 节点，通过 Command 动态路由
 * - checkpointer 必需（interrupt() 依赖持久化保存暂停点状态）
 * - 图实例延迟编译（同 ReactService.getDurableGraph 策略）
 */
@Injectable()
export class HitlService {
  private readonly logger = new Logger(HitlService.name);

  /** HITL 图（延迟初始化） */
  private hitlGraph: HitlGraphCompiled | null = null;

  constructor(
    private readonly modelFactory: AiModelFactory,
    private readonly toolRegistry: ToolRegistry,
    private readonly configService: ConfigService,
    private readonly reasoningNormalizer: ReasoningNormalizer,
    private readonly checkpointService: CheckpointService,
  ) {}

  /**
   * 获取 HITL 图实例（延迟编译）
   *
   * 在首次调用时编译带 checkpointer + reviewToolCalls 的图。
   * 延迟初始化是因为 CheckpointService 的 PostgresSaver.setup()
   * 在 onModuleInit 中异步完成，构造函数阶段尚不可用。
   *
   * @returns 编译后的 HITL 图实例
   */
  getHitlGraph(): HitlGraphCompiled {
    if (!this.hitlGraph) {
      const checkpointer = this.checkpointService.getCheckpointer();
      this.hitlGraph = buildHitlToolGraph({ checkpointer });
      this.logger.log(
        `HITL 图已编译（${this.checkpointService.isPostgresBacked() ? 'PostgresSaver' : 'MemorySaver'}）`,
      );
    }
    return this.hitlGraph;
  }

  /**
   * 获取运行时类型桥接的 HITL 图
   *
   * LangGraph 的泛型约束会把 configurable 限定到 contextSchema，
   * 但 HITL 需要额外传入 thread_id。通过局部接口桥接保持强类型。
   */
  private getRuntimeGraph(): HitlRuntimeGraph {
    return this.getHitlGraph() as unknown as HitlRuntimeGraph;
  }

  // ============================================================
  // 非流式调用
  // ============================================================

  /**
   * HITL 首次调用（非流式）
   *
   * 完整流程：
   * 1. 校验模型 tool calling 能力
   * 2. 输入安全守卫
   * 3. 注入 ReAct 系统提示词
   * 4. 通过 HITL 图执行（模型推理 → reviewToolCalls 中断）
   * 5. 检测 __interrupt__ 构建响应
   *
   * @param params - 调用参数
   * @param threadConfig - 线程配置
   * @returns 执行结果（completed 或 interrupted）
   * @throws {BadRequestException} 当模型不支持 tool calling 或输入不安全时
   */
  async invoke(
    params: HitlInvokeParams,
    threadConfig: HitlThreadConfig,
  ): Promise<HitlInvokeResult> {
    this.validateToolCallingSupport(params.provider, params.model);
    if (params.messages?.length) {
      validateInput(params.messages);
    }

    const tracer = new LangChainTracer(this.logger);
    const maxIterations = params.maxIterations ?? 5;
    const durability =
      threadConfig.durability ??
      this.checkpointService.getDefaultDurabilityMode();

    this.logger.log(
      `[HITL] 首次调用，线程: ${threadConfig.threadId}，` +
        `提供商: ${params.provider}，模型: ${params.model}，` +
        `持久化模式: ${durability}`,
    );

    const model = this.modelFactory.createChatModel(params.provider, {
      model: params.model,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
    });

    const tools = this.toolRegistry.getTools(params.toolNames);
    const messages = this.buildReactMessages(
      params.messages,
      params.systemPrompt,
    );
    const context: HitlGraphContext = {
      model,
      tools,
      maxIterations,
      hitlConfig: {
        enabled: true,
        autoApproveTools: params.autoApproveTools,
      },
    };

    const result = await this.getRuntimeGraph().invoke(
      { messages },
      {
        context,
        callbacks: [tracer],
        configurable: { thread_id: threadConfig.threadId },
        durability,
      },
    );

    return this.buildHitlResult(
      result,
      tracer,
      params.provider,
      threadConfig.threadId,
    );
  }

  /**
   * HITL 恢复执行（非流式）
   *
   * 审批人提交决策后恢复被 interrupt() 暂停的图执行。
   * 使用 Command({ resume }) 将审批决策传回 reviewToolCalls 节点。
   *
   * 支持两种审批粒度：
   * - 批量模式（ReviewDecision）：所有工具统一 approve 或 reject
   * - 逐工具模式（ToolCallDecision[]）：每个工具独立决策
   *
   * resume 后可能出现的情况：
   * - 图正常完成 → status: 'completed'
   * - 新一轮工具调用再次触发 interrupt → status: 'interrupted'
   *
   * @param threadConfig - 线程配置（必须与 invoke 时的 threadId 一致）
   * @param resumeValue - 审批决策（批量 ReviewDecision 或逐工具 ToolCallDecision[]）
   * @param params - 调用参数（provider/model 用于后续可能的模型调用）
   * @returns 执行结果
   */
  async resume(
    threadConfig: HitlThreadConfig,
    resumeValue: HitlResumeValue,
    params: HitlInvokeParams,
  ): Promise<HitlInvokeResult> {
    const tracer = new LangChainTracer(this.logger);
    const maxIterations = params.maxIterations ?? 5;
    // 获取持久化模式
    const durability =
      threadConfig.durability ??
      this.checkpointService.getDefaultDurabilityMode();

    const mode = Array.isArray(resumeValue) ? 'per-tool' : 'batch';

    const actionSummary = Array.isArray(resumeValue)
      ? `${resumeValue.length} 个逐工具决策`
      : resumeValue.action;
    this.logger.log(
      `[HITL] 恢复执行，线程: ${threadConfig.threadId}，` +
        `模式: ${mode}，决策: ${actionSummary}`,
    );

    const model = this.modelFactory.createChatModel(params.provider, {
      model: params.model,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
    });

    const tools = this.toolRegistry.getTools(params.toolNames);
    const context: HitlGraphContext = {
      model,
      tools,
      maxIterations,
      hitlConfig: {
        enabled: true,
        autoApproveTools: params.autoApproveTools,
      },
    };

    // 构建 Command 命令，传递 resumeValue 给 reviewToolCalls 节点
    const resumeCommand = new Command({ resume: resumeValue });

    // 执行 HITL 图
    const result = await this.getRuntimeGraph().invoke(
      resumeCommand as unknown as HitlGraphInput,
      {
        context,
        callbacks: [tracer],
        configurable: { thread_id: threadConfig.threadId },
        durability,
      },
    );

    return this.buildHitlResult(
      result,
      tracer,
      params.provider,
      threadConfig.threadId,
    );
  }

  // ============================================================
  // 流式调用
  // ============================================================

  /**
   * HITL 首次流式调用
   *
   * 流式版本的 HITL 调用。token 级实时推送，
   * 当 interrupt() 触发时发射 INTERRUPT 事件。
   *
   * @param params - 调用参数
   * @param threadConfig - 线程配置
   * @returns StreamChunk 的 Observable 流
   * @throws {BadRequestException} 当模型不支持 tool calling 或输入不安全时
   */
  stream(
    params: HitlInvokeParams,
    threadConfig: HitlThreadConfig,
  ): Observable<StreamChunk> {
    this.validateToolCallingSupport(params.provider, params.model);
    if (params.messages?.length) {
      validateInput(params.messages);
    }

    return new Observable<StreamChunk>((subscriber) => {
      const abortController = new AbortController();

      void this.runHitlStream(
        {
          messages: this.buildReactMessages(
            params.messages,
            params.systemPrompt,
          ),
        },
        params,
        threadConfig,
        subscriber,
        abortController.signal,
      );

      return () => abortController.abort();
    });
  }

  /**
   * HITL 恢复流式调用
   *
   * 流式版本的 resume。审批决策通过 Command({ resume }) 传入，
   * 后续 token 实时推送。
   *
   * @param threadConfig - 线程配置
   * @param resumeValue - 审批决策（批量或逐工具）
   * @param params - 调用参数
   * @returns StreamChunk 的 Observable 流
   */
  resumeStream(
    threadConfig: HitlThreadConfig,
    resumeValue: HitlResumeValue,
    params: HitlInvokeParams,
  ): Observable<StreamChunk> {
    return new Observable<StreamChunk>((subscriber) => {
      const abortController = new AbortController();

      void this.runHitlStream(
        new Command({ resume: resumeValue }),
        params,
        threadConfig,
        subscriber,
        abortController.signal,
      );

      return () => abortController.abort();
    });
  }

  /**
   * HITL 流式执行内部实现
   *
   * input 可以是:
   * - { messages: BaseMessage[] }: 首次调用
   * - Command({ resume }): 恢复执行
   */
  private async runHitlStream(
    input: HitlGraphInput | Command,
    params: HitlInvokeParams,
    threadConfig: HitlThreadConfig,
    subscriber: Subscriber<StreamChunk>,
    signal: AbortSignal,
  ): Promise<void> {
    const tracer = new LangChainTracer(this.logger);
    const startTime = Date.now();
    const maxIterations = params.maxIterations ?? 5;
    const durability =
      threadConfig.durability ??
      this.checkpointService.getDefaultDurabilityMode();

    try {
      const model = this.modelFactory.createChatModel(params.provider, {
        model: params.model,
        streaming: true,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
      });

      const tools = this.toolRegistry.getTools(params.toolNames);
      const context: HitlGraphContext = {
        model,
        tools,
        maxIterations,
        hitlConfig: {
          enabled: true,
          autoApproveTools: params.autoApproveTools,
        },
      };

      // 推送线程 ID 元信息
      subscriber.next({
        type: StreamChunkType.META,
        meta: { threadId: threadConfig.threadId },
      });

      const stream = await this.getRuntimeGraph().stream(
        input as unknown as HitlGraphInput,
        {
          context,
          callbacks: [tracer],
          streamMode: ['messages', 'updates'],
          signal,
          configurable: { thread_id: threadConfig.threadId },
          durability,
        },
      );

      for await (const chunk of stream) {
        if (signal.aborted) break;

        const [streamMode, data] = chunk as [string, unknown];
        if (streamMode === 'messages') {
          this.processMessagesChunk(data, params.provider, subscriber);
        } else if (streamMode === 'updates') {
          this.processUpdatesChunk(data as Record<string, unknown>, subscriber);
        }
      }

      // 流结束后检查是否有 pending interrupt
      if (!signal.aborted) {
        const interruptInfo = await this.checkPendingInterrupt(
          threadConfig.threadId,
        );

        if (interruptInfo) {
          subscriber.next({
            type: StreamChunkType.INTERRUPT,
            interrupt: {
              type: interruptInfo.type,
              toolCalls: interruptInfo.toolCalls,
              message: interruptInfo.message,
            },
          });
        }

        const traceSummary = tracer.logSummary();
        subscriber.next({
          type: StreamChunkType.DONE,
          trace: {
            traceId: traceSummary.traceId,
            totalLatencyMs: traceSummary.totalLatencyMs,
            llmCallCount: traceSummary.llmCallCount,
            llmTotalLatencyMs: traceSummary.llmTotalLatencyMs,
            totalTokens: traceSummary.totalTokenUsage.total,
          },
        });
      }

      subscriber.complete();
    } catch (error) {
      this.handleStreamError(error, signal, startTime, subscriber);
    }
  }

  // ============================================================
  // 中断检测
  // ============================================================

  /**
   * 检查线程是否有 pending interrupt
   *
   * 流式执行结束后调用，通过 getState() 检测图是否停在 interrupt() 处。
   * 当 state.next 不为空（图未完成）时，说明有 pending interrupt。
   *
   * @param threadId - 线程 ID
   * @returns 中断载荷（无中断时返回 null）
   */
  private async checkPendingInterrupt(threadId: string): Promise<{
    type: string;
    toolCalls: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }>;
    message: string;
  } | null> {
    try {
      const state = await this.getRuntimeGraph().getState({
        configurable: { thread_id: threadId },
      });

      // next 非空表示图执行未完成（停在某个节点的 interrupt 处）
      if (state?.next?.length) {
        // 从 state values 中提取最后一个 AIMessage 的 tool_calls 来构建中断信息
        const messages = (state.values?.messages ?? []) as BaseMessage[];
        const lastAiMessage = [...messages]
          .reverse()
          .find((m) => m instanceof AIMessage) as AIMessage | undefined;

        if (lastAiMessage?.tool_calls?.length) {
          const toolCalls = lastAiMessage.tool_calls.map((tc) => ({
            id:
              tc.id ??
              `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: tc.name,
            arguments: tc.args as Record<string, unknown>,
          }));

          return {
            type: 'tool_call_review',
            toolCalls,
            message: `Agent 请求调用 ${toolCalls.length} 个工具，请审批。`,
          };
        }
      }
    } catch (error) {
      this.logger.warn(
        `检查 pending interrupt 失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return null;
  }

  // ============================================================
  // 结果构建
  // ============================================================

  /**
   * 构建 HITL 调用结果
   *
   * 检测 __interrupt__ 字段判断执行是完成还是中断：
   * - 有 __interrupt__ → status: 'interrupted'，提取中断载荷
   * - 无 __interrupt__ → status: 'completed'，提取最终响应
   *
   * @param result - 图执行的最终 state（可能含 __interrupt__）
   * @param tracer - 链路追踪器
   * @param provider - AI 提供商标识
   * @param threadId - 线程 ID
   * @returns 统一的 HITL 调用结果
   */
  private buildHitlResult(
    result: HitlGraphResult,
    tracer: LangChainTracer,
    provider: string,
    threadId: string,
  ): HitlInvokeResult {
    const traceSummary = tracer.logSummary();

    // 检查是否被 interrupt
    const interrupts = result.__interrupt__;
    if (interrupts?.length) {
      const interruptValue = interrupts[0].value;
      this.logger.log(
        `[HITL] 图在 interrupt() 处暂停，线程: ${threadId}，` +
          `待审批工具: ${interruptValue.toolCalls.map((tc) => tc.name).join(', ')}`,
      );

      return {
        status: 'interrupted',
        threadId,
        interrupt: interruptValue,
        trace: {
          traceId: traceSummary.traceId,
          totalLatencyMs: traceSummary.totalLatencyMs,
          llmCallCount: traceSummary.llmCallCount,
          totalTokens: traceSummary.totalTokenUsage.total,
        },
      };
    }

    // 图正常完成
    const messages = result['messages'] as BaseMessage[];
    const lastMessage = messages[messages.length - 1];

    const normalized = this.reasoningNormalizer.normalize(
      provider,
      lastMessage as unknown as Record<string, unknown>,
    );

    return {
      status: 'completed',
      threadId,
      content: normalized.content,
      reasoning: normalized.reasoning ?? undefined,
      iterationCount: (result['iterationCount'] as number) ?? 0,
      toolCallCount: (result['toolCallCount'] as number) ?? 0,
      usage: this.extractUsage(lastMessage),
      trace: {
        traceId: traceSummary.traceId,
        totalLatencyMs: traceSummary.totalLatencyMs,
        llmCallCount: traceSummary.llmCallCount,
        totalTokens: traceSummary.totalTokenUsage.total,
      },
    };
  }

  // ============================================================
  // 流式 Chunk 处理
  // ============================================================

  /**
   * 处理 'messages' 模式 — token 级文本流
   */
  private processMessagesChunk(
    data: unknown,
    provider: string,
    subscriber: Subscriber<StreamChunk>,
  ): void {
    const [message] = data as [BaseMessage, unknown];

    if (message instanceof AIMessageChunk) {
      const reasoning = this.reasoningNormalizer.extractReasoning(
        provider,
        message as unknown as Record<string, unknown>,
      );
      if (reasoning) {
        subscriber.next({
          type: StreamChunkType.REASONING,
          content: reasoning,
        });
      }

      const content =
        typeof message.content === 'string' ? message.content : '';
      if (content) {
        subscriber.next({ type: StreamChunkType.TEXT, content });
      }
    }
  }

  /**
   * 处理 'updates' 模式 — 节点级结构化事件
   */
  private processUpdatesChunk(
    chunk: Record<string, unknown>,
    subscriber: Subscriber<StreamChunk>,
  ): void {
    this.extractToolCalls(chunk, subscriber);
    this.extractToolResults(chunk, subscriber);
  }

  /**
   * 从 callModel 节点更新中提取工具调用请求
   */
  private extractToolCalls(
    chunk: Record<string, unknown>,
    subscriber: Subscriber<StreamChunk>,
  ): void {
    if (!chunk['callModel']) return;

    const update = chunk['callModel'] as Record<string, unknown>;
    const messages = update['messages'] as BaseMessage[] | undefined;
    const lastMsg = messages?.[messages.length - 1];

    if (lastMsg instanceof AIMessage && lastMsg.tool_calls?.length) {
      for (const tc of lastMsg.tool_calls) {
        subscriber.next({
          type: StreamChunkType.TOOL_CALL,
          toolCall: {
            id:
              tc.id ??
              `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: tc.name,
            arguments: tc.args as Record<string, unknown>,
          },
        });
      }
    }
  }

  /**
   * 从 executeTools 节点更新中提取工具结果
   */
  private extractToolResults(
    chunk: Record<string, unknown>,
    subscriber: Subscriber<StreamChunk>,
  ): void {
    if (!chunk['executeTools']) return;

    const update = chunk['executeTools'] as Record<string, unknown>;
    const messages = update['messages'] as BaseMessage[] | undefined;

    if (messages) {
      for (const msg of messages) {
        if (msg instanceof ToolMessage) {
          subscriber.next({
            type: StreamChunkType.TOOL_RESULT,
            toolResult: {
              toolCallId: msg.tool_call_id,
              name: msg.name ?? 'unknown',
              result:
                typeof msg.content === 'string'
                  ? msg.content
                  : JSON.stringify(msg.content),
            },
          });
        }
      }
    }
  }

  // ============================================================
  // 工具方法
  // ============================================================

  /**
   * 构建带有 ReAct 系统提示词的消息列表
   */
  private buildReactMessages(
    messages: Message[],
    customSystemPrompt?: string,
  ): BaseMessage[] {
    const systemPrompt = buildReactPrompt(customSystemPrompt);
    return convertToLangChainMessages(messages, systemPrompt);
  }

  /**
   * 校验模型是否支持 tool calling
   *
   * @throws {BadRequestException} 当模型明确不支持 tool calling 时
   */
  private validateToolCallingSupport(provider: string, modelId: string): void {
    const modelDef = MODEL_REGISTRY.find(
      (m) => m.id === modelId && m.provider === (provider as AiProvider),
    );

    if (!modelDef) {
      this.logger.warn(
        `模型 "${modelId}" 未在 MODEL_REGISTRY 中注册，跳过工具调用能力预检`,
      );
      return;
    }

    if (!modelDef.capabilities.toolCalls) {
      throw new BadRequestException(
        `模型 "${modelDef.name}"（${modelId}）不支持 tool calling，` +
          '无法使用 HITL Agent。请切换到支持 tool calling 的模型。',
      );
    }
  }

  /**
   * 从模型响应消息中提取 token 使用统计
   */
  private extractUsage(
    message: BaseMessage,
  ): HitlInvokeResult['usage'] | undefined {
    const usageMeta = (message as AIMessage).usage_metadata;
    if (usageMeta) {
      return {
        promptTokens: usageMeta.input_tokens ?? 0,
        completionTokens: usageMeta.output_tokens ?? 0,
        totalTokens: usageMeta.total_tokens ?? 0,
      };
    }
    return undefined;
  }

  /**
   * 处理流式执行错误
   */
  private handleStreamError(
    error: unknown,
    signal: AbortSignal,
    startTime: number,
    subscriber: Subscriber<StreamChunk>,
  ): void {
    if (signal.aborted) {
      this.logger.debug(
        `[HITL] 流式执行已取消，耗时 ${Date.now() - startTime}ms`,
      );
      subscriber.complete();
      return;
    }

    this.logger.error(
      `[HITL] 流式执行失败，耗时 ${Date.now() - startTime}ms`,
      error,
    );
    subscriber.next({
      type: StreamChunkType.ERROR,
      error: error instanceof Error ? error.message : String(error),
    });
    subscriber.complete();
  }
}
