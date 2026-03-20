import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AIMessage,
  AIMessageChunk,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { Observable, type Subscriber } from 'rxjs';

import { AiModelFactory } from '../factories/model.factory';
import { ToolRegistry } from '../tools/tool.registry';
import { ReasoningNormalizer } from '../normalizers/reasoning.normalizer';
import { LangChainTracer } from '../observability';
import { AiProvider, StreamChunkType } from '../constants';
import { MODEL_REGISTRY } from '../constants/model-registry';
import type { StreamChunk, Message } from '../interfaces';
import { convertToLangChainMessages } from '../utils';

import { buildToolGraph, type ToolGraphCompiled } from './single';
import { buildReactPrompt } from './single/react-agent/react-agent.prompts';
import type { ToolGraphContext } from './shared/nodes';
import { validateInput } from './shared/guards';
import { CheckpointService } from './persistence';

/**
 * 持久化调用附加参数（049 Durable Execution）
 */
export interface ThreadConfig {
  /** 线程 ID — 同一 thread_id 的后续调用在现有状态上继续执行 */
  threadId: string;
  /**
   * 持久化模式
   * - 'sync': 每步同步写入 checkpoint，最高可靠性
   * - 'async': 异步写入，高性能但进程崩溃可能丢失最后一步
   * - 'exit': 仅退出时写入，最佳性能但中间状态不保存
   */
  durability?: 'sync' | 'async' | 'exit';
}

/**
 * ReAct Agent 调用参数
 */
export interface ReactInvokeParams {
  provider: string;
  model: string;
  messages: Message[];
  /** 自定义系统提示词，不提供时使用默认 ReAct 提示词 */
  systemPrompt?: string;
  toolNames?: string[];
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
}

/**
 * ReAct Agent 调用结果
 */
export interface ReactInvokeResult {
  content: string;
  reasoning?: string;
  iterationCount: number;
  toolCallCount: number;
  /** 线程 ID（仅在持久化调用时返回） */
  threadId?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  trace?: {
    traceId: string;
    totalLatencyMs: number;
    llmCallCount: number;
    totalTokens: number;
  };
}

type DurableGraphInput = { messages: BaseMessage[] } | null;

type DurableGraphResult = Record<string, unknown>;

type DurableGraphStreamChunk = [string, unknown];

type DurableGraphStream = AsyncIterable<DurableGraphStreamChunk>;

interface DurableGraphInvokeOptions {
  context: ToolGraphContext;
  callbacks: LangChainTracer[];
  configurable: { thread_id: string };
  durability: 'sync' | 'async' | 'exit';
}

interface DurableGraphStreamOptions extends DurableGraphInvokeOptions {
  streamMode: ['messages', 'updates'];
  signal: AbortSignal;
}

interface DurableRuntimeGraph {
  invoke(
    input: DurableGraphInput,
    options: DurableGraphInvokeOptions,
  ): Promise<DurableGraphResult>;
  stream(
    input: DurableGraphInput,
    options: DurableGraphStreamOptions,
  ): Promise<DurableGraphStream>;
}

/**
 * ReAct Service — 生产级 ReAct 智能体服务
 *
 * 与 047 GraphService 的关键差异：
 * 1. 内置 ReAct 系统提示词，引导模型遵循 Thought → Action → Observation 循环
 * 2. 输入安全守卫（Prompt Injection 检测 + 长度/数量限制）
 *
 * 架构决策：
 * - 复用 047 的图拓扑和共享节点，ReAct 的核心差异在服务层（提示词 + 守卫）
 * - 图在构造函数中 compile 一次，运行时通过 contextSchema 注入 model/tools
 * - createReactAgent 的内部机制已在文档中拆解，生产代码只保留自建图路径
 *
 * 049 新增 Durable Execution：
 * - durableGraph：带 checkpointer 的图实例，每个 super-step 边界自动保存状态
 * - invokeWithThread / streamWithThread：线程感知的执行方法
 * - 通过 thread_id 实现断点续传、错误恢复、跨请求状态保持
 */
@Injectable()
export class ReactService {
  private readonly logger = new Logger(ReactService.name);

  /** ReAct 图（无持久化，用于 048 端点） */
  private readonly graph: ToolGraphCompiled;

  /** 持久化 ReAct 图（带 checkpointer，用于 049 端点）— 延迟初始化 */
  private durableGraph: ToolGraphCompiled | null = null;

  constructor(
    private readonly modelFactory: AiModelFactory,
    private readonly toolRegistry: ToolRegistry,
    private readonly configService: ConfigService,
    private readonly reasoningNormalizer: ReasoningNormalizer,
    private readonly checkpointService: CheckpointService,
  ) {
    this.graph = buildToolGraph();
    this.logger.log('ReAct Agent graph 已编译完成');
  }

  /**
   * 获取持久化图实例（延迟编译）
   *
   * 在首次调用时编译带 checkpointer 的图。
   * 延迟初始化是因为 CheckpointService 的 PostgresSaver.setup()
   * 在 onModuleInit 中异步完成，构造函数阶段尚不可用。
   *
   * @returns 带 checkpointer 的编译后图实例
   */
  getDurableGraph(): ToolGraphCompiled {
    if (!this.durableGraph) {
      // 获取checkpoint存储器 checkpointer
      const checkpointer = this.checkpointService.getCheckpointer();
      this.durableGraph = buildToolGraph({ checkpointer });
      this.logger.log(
        `持久化 ReAct 图已编译（${this.checkpointService.isPostgresBacked() ? 'PostgresSaver' : 'MemorySaver'}）`,
      );
    }
    return this.durableGraph;
  }

  /**
   * 获取线程运行时使用的持久化图接口
   *
   * LangGraph 当前的泛型声明会把 `configurable` 约束到 `contextSchema`，
   * 但 Durable Execution 需要额外传入 `thread_id`。这里通过局部接口桥接，
   * 保持调用点仍然是强类型，而不是退化成 `Function` / `any`。
   */
  private getDurableRuntimeGraph(): DurableRuntimeGraph {
    return this.getDurableGraph() as unknown as DurableRuntimeGraph;
  }

  // ============================================================
  // 非流式调用
  // ============================================================

  /**
   * ReAct Agent 非流式调用
   *
   * 完整流程：
   * 1. 校验模型 tool calling 能力
   * 2. 输入安全守卫（Prompt Injection 检测 + 长度/数量限制）
   * 3. 注入 ReAct 系统提示词
   * 4. 通过 contextSchema 注入 model/tools，执行状态图
   * 5. 提取最终 AIMessage 构建响应
   *
   * @param params - ReAct 调用参数
   * @returns ReAct 调用结果
   * @throws {BadRequestException} 当模型不支持 tool calling 或输入不安全时
   */
  async invoke(params: ReactInvokeParams): Promise<ReactInvokeResult> {
    // 校验模型是否支持 tool calling
    this.validateToolCallingSupport(params.provider, params.model);
    // 校验输入是否安全
    validateInput(params.messages);

    // 创建链路追踪器
    const tracer = new LangChainTracer(this.logger);
    // 获取最大迭代次数
    const maxIterations = params.maxIterations ?? 5;

    this.logger.log(
      `[ReAct] 执行 ReAct Agent，提供商: ${params.provider}, ` +
        `模型: ${params.model}, traceId: ${tracer.getTraceId()}`,
    );

    const model = this.modelFactory.createChatModel(params.provider, {
      model: params.model,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
    });

    const tools = this.toolRegistry.getTools(params.toolNames);
    // 构建 ReAct 消息列表,包含 ReAct 系统提示词
    const messages = this.buildReactMessages(
      params.messages,
      params.systemPrompt,
    );

    // 构建工具调用图的上下文
    const context: ToolGraphContext = { model, tools, maxIterations };

    // 执行 ReAct 图
    const result = await this.graph.invoke(
      { messages },
      { context, callbacks: [tracer] },
    );

    return this.buildResult(result, tracer, params.provider);
  }

  // ============================================================
  // 流式调用
  // ============================================================

  /**
   * ReAct Agent 流式调用
   *
   * 返回 Cold Observable，订阅时启动流式执行。
   * 客户端断开时通过 AbortController 取消后端执行。
   *
   * @param params - ReAct 调用参数
   * @returns StreamChunk 的 Observable 流
   * @throws {BadRequestException} 当模型不支持 tool calling 或输入不安全时
   */
  stream(params: ReactInvokeParams): Observable<StreamChunk> {
    this.validateToolCallingSupport(params.provider, params.model);
    validateInput(params.messages);

    return new Observable<StreamChunk>((subscriber) => {
      const abortController = new AbortController();

      void this.runStream(params, subscriber, abortController.signal);

      return () => abortController.abort();
    });
  }

  /**
   * 流式执行 ReAct 图
   *
   * 使用 ['messages', 'updates'] 双模式流：
   * - messages: token 级实时推送（用户看到逐字输出）
   * - updates: 节点级结构化事件（提取 tool_calls / tool_results）
   */
  private async runStream(
    params: ReactInvokeParams,
    subscriber: Subscriber<StreamChunk>,
    signal: AbortSignal,
  ): Promise<void> {
    const tracer = new LangChainTracer(this.logger);
    const startTime = Date.now();
    // 获取最大迭代次数
    const maxIterations = params.maxIterations ?? 5;

    try {
      const model = this.modelFactory.createChatModel(params.provider, {
        model: params.model,
        streaming: true,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
      });

      const tools = this.toolRegistry.getTools(params.toolNames);
      const messages = this.buildReactMessages(
        params.messages,
        params.systemPrompt,
      );
      const context: ToolGraphContext = { model, tools, maxIterations };

      const stream = await this.graph.stream(
        { messages },
        {
          context,
          callbacks: [tracer],
          streamMode: ['messages', 'updates'],
          signal,
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

      this.emitDone(signal, tracer, subscriber);
    } catch (error) {
      this.handleStreamError(error, signal, startTime, subscriber);
    }
  }

  // ============================================================
  // 049 Durable Execution — 线程感知的持久化调用
  // ============================================================

  /**
   * ReAct Agent 线程感知非流式调用（Durable Execution）
   *
   * 与 invoke() 的关键差异：
   * - 使用带 checkpointer 的持久化图
   * - 通过 thread_id 标识执行上下文，同一线程的后续调用延续之前的状态
   * - 支持三种持久化模式（sync/async/exit）
   * - messages 为 null 时触发错误恢复（从最后一个成功的 checkpoint 恢复）
   *
   * @param params - ReAct 调用参数（messages 为 null 时触发恢复执行）
   * @param threadConfig - 线程配置（threadId + durability 模式）
   * @returns ReAct 调用结果
   * @throws {BadRequestException} 当模型不支持 tool calling 或输入不安全时
   */
  async invokeWithThread(
    params: ReactInvokeParams,
    threadConfig: ThreadConfig,
  ): Promise<ReactInvokeResult> {
    this.validateToolCallingSupport(params.provider, params.model);

    // 当 messages 非空时才做输入安全校验（null 表示恢复执行）
    if (params.messages?.length) {
      validateInput(params.messages);
    }

    const tracer = new LangChainTracer(this.logger);
    // 获取最大迭代次数
    const maxIterations = params.maxIterations ?? 5;
    // 获取持久化模式
    const durability =
      threadConfig.durability ??
      this.checkpointService.getDefaultDurabilityMode();

    this.logger.log(
      `[ReAct:Durable] 线程 ${threadConfig.threadId}，` +
        `提供商: ${params.provider}, 模型: ${params.model}, ` +
        `持久化模式: ${durability}, traceId: ${tracer.getTraceId()}`,
    );

    const model = this.modelFactory.createChatModel(params.provider, {
      model: params.model,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
    });

    const tools = this.toolRegistry.getTools(params.toolNames);

    // 构建 ReAct 消息列表,包含 ReAct 系统提示词
    // 恢复执行时 input 为 null，图从最后一个 checkpoint 继续
    const input = params.messages?.length
      ? {
          messages: this.buildReactMessages(
            params.messages,
            params.systemPrompt,
          ),
        }
      : null;

    // 构建工具调用图的上下文
    const context: ToolGraphContext = { model, tools, maxIterations };

    // 获取持久化图实例 并 执行持久化图
    const result = await this.getDurableRuntimeGraph().invoke(input, {
      context,
      callbacks: [tracer],
      configurable: { thread_id: threadConfig.threadId },
      durability,
    });

    const invokeResult = this.buildResult(result, tracer, params.provider);

    return {
      ...invokeResult,
      threadId: threadConfig.threadId,
    };
  }

  /**
   * ReAct Agent 线程感知流式调用（Durable Execution）
   *
   * 流式版本的持久化执行，每个 token 实时推送。
   *
   * @param params - ReAct 调用参数
   * @param threadConfig - 线程配置
   * @returns StreamChunk 的 Observable 流
   * @throws {BadRequestException} 当模型不支持 tool calling 或输入不安全时
   */
  streamWithThread(
    params: ReactInvokeParams,
    threadConfig: ThreadConfig,
  ): Observable<StreamChunk> {
    this.validateToolCallingSupport(params.provider, params.model);
    if (params.messages?.length) {
      validateInput(params.messages);
    }

    return new Observable<StreamChunk>((subscriber) => {
      const abortController = new AbortController();

      void this.runDurableStream(
        params,
        threadConfig,
        subscriber,
        abortController.signal,
      );

      return () => abortController.abort();
    });
  }

  /**
   * 持久化流式执行内部实现
   */
  private async runDurableStream(
    params: ReactInvokeParams,
    threadConfig: ThreadConfig,
    subscriber: Subscriber<StreamChunk>,
    signal: AbortSignal,
  ): Promise<void> {
    const tracer = new LangChainTracer(this.logger);
    const startTime = Date.now();
    const maxIterations = params.maxIterations ?? 5;
    // 获取持久化模式
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

      const input = params.messages?.length
        ? {
            messages: this.buildReactMessages(
              params.messages,
              params.systemPrompt,
            ),
          }
        : null;

      const context: ToolGraphContext = { model, tools, maxIterations };

      // 推送线程 ID 元信息，前端可据此管理会话
      subscriber.next({
        type: StreamChunkType.META,
        meta: { threadId: threadConfig.threadId },
      });

      const stream = await this.getDurableRuntimeGraph().stream(input, {
        context,
        callbacks: [tracer],
        streamMode: ['messages', 'updates'],
        signal,
        configurable: { thread_id: threadConfig.threadId },
        durability,
      });

      for await (const chunk of stream) {
        if (signal.aborted) break;

        const [streamMode, data] = chunk as [string, unknown];
        if (streamMode === 'messages') {
          this.processMessagesChunk(data, params.provider, subscriber);
        } else if (streamMode === 'updates') {
          this.processUpdatesChunk(data as Record<string, unknown>, subscriber);
        }
      }

      this.emitDone(signal, tracer, subscriber);
    } catch (error) {
      this.handleStreamError(error, signal, startTime, subscriber);
    }
  }

  // ============================================================
  // 流式 Chunk 处理
  // ============================================================

  /**
   * 处理 'messages' 流式模式 — token 级文本流
   *
   * StateGraph.stream() 的 'messages' 模式会发射 [AIMessageChunk, metadata] 元组，
   * 每个 chunk 包含模型生成的一小段文本（通常 1-5 个 token）。
   *
   * 此方法从元组中提取 AIMessageChunk 的文本内容，发射 TEXT 事件供前端实时渲染。
   *
   * @param data - 流式数据，格式为 [AIMessageChunk, metadata]
   * @param subscriber - RxJS 订阅者，用于发射事件
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
   *
   * 从 callModel 节点提取 tool_calls，从 executeTools 节点提取工具结果。
   *
   * @param chunk - 节点状态更新，格式为 { [nodeName]: partialState }
   * @param subscriber - RxJS Subscriber
   */
  private processUpdatesChunk(
    chunk: Record<string, unknown>,
    subscriber: Subscriber<StreamChunk>,
  ): void {
    this.extractToolCalls(chunk, subscriber);
    this.extractToolResults(chunk, subscriber);
  }

  /**
   * 从 StateGraph 流式更新中提取模型发出的工具调用请求
   *
   * 当 callModel 节点执行完毕后，StateGraph 会发射形如
   * { callModel: { messages: [AIMessage] } } 的更新块。
   * AIMessage 中的 tool_calls 字段包含模型决定调用的工具列表。
   *
   * 流程：
   * 1. 检查 chunk 是否包含 callModel 节点的更新
   * 2. 获取 messages 数组的最后一条（即模型最新响应）
   * 3. 若为 AIMessage 且含 tool_calls，逐个发射 TOOL_CALL 事件
   *
   * @param chunk - StateGraph 流式更新块
   * @param subscriber - RxJS 订阅者，用于发射事件
   */
  private extractToolCalls(
    chunk: Record<string, unknown>,
    subscriber: Subscriber<StreamChunk>,
  ): void {
    if (!chunk['callModel']) return;

    // StateGraph 流式更新格式: { 节点名: { 更新字段 } }
    // 例如: { callModel: { messages: [AIMessage] } }
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
   * 从 StateGraph 流式更新中提取工具执行结果
   *
   * 当 executeTools 节点执行完毕后，StateGraph 会发射形如
   * { executeTools: { messages: [ToolMessage, ...] } } 的更新块。
   * 此方法解析该结构，将每个 ToolMessage 转换为 TOOL_RESULT 事件发射给前端。
   *
   * 流程：
   * 1. 检查 chunk 是否包含 executeTools 节点的更新
   * 2. 从更新中提取 messages 数组
   * 3. 过滤出 ToolMessage 实例（排除其他消息类型）
   * 4. 发射 TOOL_RESULT 事件，包含工具名、调用 ID 和执行结果
   *
   * @param chunk - StateGraph 流式更新块
   * @param subscriber - RxJS 订阅者，用于发射事件
   */
  private extractToolResults(
    chunk: Record<string, unknown>,
    subscriber: Subscriber<StreamChunk>,
  ): void {
    if (!chunk['executeTools']) return;

    // StateGraph 流式更新格式: { 节点名: { 更新字段 } }
    // 例如: { executeTools: { messages: [ToolMessage] } }
    const update = chunk['executeTools'] as Record<string, unknown>;
    // 从更新中提取 messages 数组
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
  // 结果构建
  // ============================================================

  /**
   * 从图执行结果构建响应
   *
   * @param result - 图执行的最终 state
   * @param tracer - 链路追踪器
   * @returns 统一的 ReAct 调用结果
   */
  private buildResult(
    result: Record<string, unknown>,
    tracer: LangChainTracer,
    provider: string,
  ): ReactInvokeResult {
    const traceSummary = tracer.logSummary();
    const messages = result['messages'] as BaseMessage[];
    const lastMessage = messages[messages.length - 1];

    const normalized = this.reasoningNormalizer.normalize(
      provider,
      lastMessage as unknown as Record<string, unknown>,
    );

    return {
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
  // 工具方法
  // ============================================================

  /**
   * 构建带有 ReAct 系统提示词的消息列表
   *
   * 始终注入 ReAct 系统提示词——这是 048 与 047 的核心差异点。
   * 如果调用方传了自定义 systemPrompt，则以自定义为准。
   */
  private buildReactMessages(
    messages: Message[],
    customSystemPrompt?: string,
  ): BaseMessage[] {
    // 构建 ReAct 系统提示词，带有时间上下文，字符串类型
    const systemPrompt = buildReactPrompt(customSystemPrompt);
    // 将消息列表转换为 LangChain 消息列表
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
          '无法使用 ReAct Agent。请切换到支持 tool calling 的模型。',
      );
    }
  }

  /**
   * 从消息中提取文本内容
   *
   * LangChain 的 BaseMessage.content 类型可能是：
   * - string：纯文本消息，直接返回
   * - Array：多模态内容（如文本 + 图片），需序列化为字符串
   *
   * @param message - LangChain 消息对象
   * @returns 消息的文本内容
   */
  private extractContent(message: BaseMessage): string {
    if (typeof message.content === 'string') return message.content;
    return JSON.stringify(message.content);
  }

  /**
   * 从模型响应消息中提取 token 使用统计信息
   *
   * LangChain 的 AIMessage 包含 usage_metadata 字段，记录本次调用的 token 消耗：
   * - input_tokens：输入 token 数（包括 system prompt + 历史消息 + 用户输入）
   * - output_tokens：输出 token 数（模型生成的回复）
   * - total_tokens：总 token 数
   *
   * @param message - 模型返回的消息（通常为 AIMessage）
   * @returns token 使用统计，如果消息不含 usage_metadata 则返回 undefined
   */
  private extractUsage(
    message: BaseMessage,
  ): ReactInvokeResult['usage'] | undefined {
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
   * 发射 DONE 事件并完成流
   */
  private emitDone(
    signal: AbortSignal,
    tracer: LangChainTracer,
    subscriber: Subscriber<StreamChunk>,
  ): void {
    if (!signal.aborted) {
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
        `[ReAct] 流式执行已取消，耗时 ${Date.now() - startTime}ms`,
      );
      subscriber.complete();
      return;
    }

    this.logger.error(
      `[ReAct] 流式执行失败，耗时 ${Date.now() - startTime}ms`,
      error,
    );
    subscriber.next({
      type: StreamChunkType.ERROR,
      error: error instanceof Error ? error.message : String(error),
    });
    subscriber.complete();
  }
}
