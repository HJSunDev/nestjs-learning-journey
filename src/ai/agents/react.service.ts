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
import { LangChainTracer } from '../observability';
import { AiProvider, StreamChunkType } from '../constants';
import { MODEL_REGISTRY } from '../constants/model-registry';
import type { StreamChunk, Message } from '../interfaces';
import { convertToLangChainMessages } from '../utils';

import { buildToolGraph, type ToolGraphCompiled } from './single';
import { buildReactPrompt } from './single/react-agent/react-agent.prompts';
import type { ToolGraphContext } from './shared/nodes';
import { validateInput } from './shared/guards';

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
  iterationCount: number;
  toolCallCount: number;
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
 */
@Injectable()
export class ReactService {
  private readonly logger = new Logger(ReactService.name);

  /** ReAct 图（与 047 ToolGraph 同拓扑，compile 一次） */
  private readonly graph: ToolGraphCompiled;

  constructor(
    private readonly modelFactory: AiModelFactory,
    private readonly toolRegistry: ToolRegistry,
    private readonly configService: ConfigService,
  ) {
    this.graph = buildToolGraph();
    this.logger.log('ReAct Agent graph 已编译完成');
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
    this.validateToolCallingSupport(params.provider, params.model);
    validateInput(params.messages);

    const tracer = new LangChainTracer(this.logger);
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
    const messages = this.buildReactMessages(
      params.messages,
      params.systemPrompt,
    );

    const context: ToolGraphContext = { model, tools, maxIterations };

    const result = await this.graph.invoke(
      { messages },
      { context, callbacks: [tracer] },
    );

    return this.buildResult(result, tracer);
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
          this.processMessagesChunk(data, subscriber);
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
   * 处理 'messages' 模式 — token 级文本流
   */
  private processMessagesChunk(
    data: unknown,
    subscriber: Subscriber<StreamChunk>,
  ): void {
    const [message] = data as [BaseMessage, unknown];

    if (message instanceof AIMessageChunk) {
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
   * 从 callModel 节点更新中提取 tool_calls 并发射 TOOL_CALL 事件
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
   * 从 executeTools 节点更新中提取工具结果并发射 TOOL_RESULT 事件
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
  ): ReactInvokeResult {
    const traceSummary = tracer.logSummary();
    const messages = result['messages'] as BaseMessage[];
    const lastMessage = messages[messages.length - 1];

    return {
      content: this.extractContent(lastMessage),
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
          '无法使用 ReAct Agent。请切换到支持 tool calling 的模型。',
      );
    }
  }

  private extractContent(message: BaseMessage): string {
    if (typeof message.content === 'string') return message.content;
    return JSON.stringify(message.content);
  }

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
