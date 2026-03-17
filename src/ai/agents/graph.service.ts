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
import type { StreamChunk } from '../interfaces';
import { buildToolGraph, type ToolGraphCompiled } from './single';
import type { ToolGraphContext } from './shared/nodes';
import type { Message } from '../interfaces';
import { convertToLangChainMessages } from '../utils';

/**
 * Graph 调用参数
 */
export interface GraphInvokeParams {
  provider: string;
  model: string;
  messages: Message[];
  systemPrompt?: string;
  toolNames?: string[];
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Graph 非流式调用结果
 */
export interface GraphInvokeResult {
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
 * Graph Service — NestJS 与 LangGraph 的桥接层
 *
 * 职责：
 * 1. 持有编译后的 StateGraph 实例（单例，compile 只执行一次）
 * 2. 将 NestJS DI 的依赖（model、tools、config）通过 contextSchema 注入图运行时
 * 3. 提供非流式 invoke 和流式 stream 两种调用方式
 * 4. 集成 LangChainTracer 实现链路追踪
 *
 * 设计决策：
 * - 图在 constructor 中 compile 一次，运行时通过 context 切换 model/tools
 * - 不在 State 中存放非序列化对象，保持 State 的纯数据特性
 * - 流式输出复用项目已有的 StreamChunk 协议，与 SSE 体系无缝集成
 */
@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);

  /** Graph API 编译产物（单例） */
  private readonly toolGraph: ToolGraphCompiled;

  constructor(
    private readonly modelFactory: AiModelFactory,
    private readonly toolRegistry: ToolRegistry,
    private readonly configService: ConfigService,
  ) {
    this.toolGraph = buildToolGraph();
    this.logger.log('ToolGraph (Graph API) 已编译完成');
  }

  /**
   * 通过 Graph API 执行工具调用图（非流式）
   *
   * 完整流程：
   * 1. 校验模型的 tool calling 能力
   * 2. AiModelFactory 创建模型实例
   * 3. ToolRegistry 获取工具列表
   * 4. 构建 context 对象（model + tools + maxIterations）
   * 5. 将用户消息转为 LangChain BaseMessage[]
   * 6. 通过 graph.invoke() 执行状态图
   * 7. 提取最终 AIMessage 作为响应
   */
  async invokeGraph(params: GraphInvokeParams): Promise<GraphInvokeResult> {
    // 校验模型是否支持 tool calling
    this.validateToolCallingSupport(params.provider, params.model);

    // 创建链路追踪器
    const tracer = new LangChainTracer(this.logger);

    // 记录日志
    this.logger.log(
      `[Graph] 执行工具调用图，提供商: ${params.provider}, 模型: ${params.model}, ` +
        `traceId: ${tracer.getTraceId()}`,
    );

    const model = this.modelFactory.createChatModel(params.provider, {
      model: params.model,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
    });

    const tools = this.toolRegistry.getTools(params.toolNames);
    const messages = this.buildMessages(params.messages, params.systemPrompt);

    // 构建工具调用图的上下文
    const context: ToolGraphContext = {
      model,
      tools,
      maxIterations: params.maxIterations ?? 5,
    };
    // 执行工具调用图
    const result = await this.toolGraph.invoke(
      { messages },
      {
        context,
        callbacks: [tracer],
      },
    );

    const traceSummary = tracer.logSummary();
    const lastMessage = result.messages[result.messages.length - 1];
    const content = this.extractContent(lastMessage);

    return {
      content,
      iterationCount: result.iterationCount ?? 0,
      toolCallCount: result.toolCallCount ?? 0,
      usage: this.extractUsage(lastMessage),
      trace: {
        traceId: traceSummary.traceId,
        totalLatencyMs: traceSummary.totalLatencyMs,
        llmCallCount: traceSummary.llmCallCount,
        totalTokens: traceSummary.totalTokenUsage.total,
      },
    };
  }

  /**
   * 通过 Graph API 执行工具调用图（流式）
   *
   * 使用 graph.stream() 的 "updates" 模式，逐节点推送状态更新。
   * 将图的节点事件映射到项目已有的 StreamChunk 协议：
   *
   * - callModel 节点输出 → 检查是否有 tool_calls
   *   - 有 → 发射 TOOL_CALL 事件
   *   - 无 → 发射 TEXT 事件（最终响应）
   * - executeTools 节点输出 → 发射 TOOL_RESULT 事件
   */
  streamGraph(params: GraphInvokeParams): Observable<StreamChunk> {
    // 校验模型是否支持 tool calling
    this.validateToolCallingSupport(params.provider, params.model);

    // 返回一个 Observable 实现流式推送，每个 next() 发射一个 StreamChunk。
    // 订阅时会启动 runGraphStream 协程按节点粒度推送事件；若客户端断开（unsubscribe），通过 AbortController 及时中止后端的流式执行（如终止大模型推理/工具调用），避免资源泄漏。
    return new Observable<StreamChunk>((subscriber) => {
      const abortController = new AbortController();

      void this.runGraphStream(params, subscriber, abortController.signal);

      // teardown：客户端断开 → adapter 调用 unsubscribe → 触发此函数 → 中止图执行
      return () => abortController.abort();
    });
  }

  /**
   * 流式执行图
   */
  private async runGraphStream(
    params: GraphInvokeParams,
    subscriber: Subscriber<StreamChunk>,
    signal: AbortSignal,
  ): Promise<void> {
    const tracer = new LangChainTracer(this.logger);
    const startTime = Date.now();

    try {
      // streaming: true 是 'messages' 模式的前提——模型内部走 SSE API，
      // LangGraph 拦截 LangChain 的流式回调，将每个 token 作为 ['messages', chunk] 推送。
      const model = this.modelFactory.createChatModel(params.provider, {
        model: params.model,
        streaming: true,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
      });

      const tools = this.toolRegistry.getTools(params.toolNames);
      const messages = this.buildMessages(params.messages, params.systemPrompt);

      // 构建工具调用图的上下文
      const context: ToolGraphContext = {
        model,
        tools,
        maxIterations: params.maxIterations ?? 5,
      };

      /**
       * 双模式流式执行：streamMode: ['messages', 'updates']
       *
       * 同时启用两种流式模式，stream 产出的每个 chunk 是元组 [mode, data]。
       *
       * ┌─────────────────────────────────────────────────────────────────────────────
       * │  'messages' 模式 — token 级流式（模型生成内容时实时推送）
       * │  - 格式: ['messages', [AIMessageChunk, metadata]]
       * │  - 触发时机: 模型每生成一个 token（约 50-200ms 间隔）
       * │  - 用途: 实时显示 AI 回复文本，用户体验好
       * └─────────────────────────────────────────────────────────────────────────────
       *
       * ┌─────────────────────────────────────────────────────────────────────────────
       * │  'updates' 模式 — 节点级流式（节点执行完成后推送）
       * │  - 格式: ['updates', { [nodeName]: partialState }]
       * │  - 触发时机: 节点执行完成（callModel/executeTools 等）
       * │  - 用途: 提取结构化数据（tool_calls、tool_results、iterationCount 等）
       * └─────────────────────────────────────────────────────────────────────────────
       *
       * **事件交错时序示例**（用户问"北京天气"，需要工具调用）：
       *
       *   callModel 节点执行期间：
       *   ├─ messages: ['messages', [AIMessageChunk("我来"), ...]]    → processMessagesChunk → 用户看到"我来"
       *   ├─ messages: ['messages', [AIMessageChunk("查"), ...]]      → processMessagesChunk → 用户看到"查"
       *   ├─ messages: ['messages', [AIMessageChunk("询"), ...]]      → processMessagesChunk → 用户看到"询"
       *   ├─ ...更多 token...
       *   └─ updates: ['updates', { callModel: {                    → processUpdatesChunk
       *        messages: [AIMessage {
       *          content: '我来查询北京天气',  ← 这段完整文本已由上面逐字推送
       *          tool_calls: [{name: 'getWeather', args: {...}}]  ← 提取这个
       *        }],
       *        iterationCount: 1
       *      }}]
       *                                                        → 发射 TOOL_CALL 事件
       *
       *   executeTools 节点执行（无 messages，因为是同步执行）：
       *   └─ updates: ['updates', { executeTools: {...} }]          → processUpdatesChunk
       *                                                        → 发射 TOOL_RESULT 事件
       *
       *   第二次 callModel 节点（生成最终回答）：
       *   ├─ messages: ['messages', [AIMessageChunk("北京"), ...]]   → processMessagesChunk → 用户看到"北京"
       *   ├─ messages: ['messages', [AIMessageChunk("今天"), ...]]   → processMessagesChunk → 用户看到"今天"
       *   ├─ ...更多 token...
       *   └─ updates: ['updates', { callModel: {...} }]            → processUpdatesChunk（无 tool_calls，忽略）
       *
       * **关键理解：**
       * - 同一个节点的执行会同时产生 messages 和 updates 事件
       * - messages 事件在节点执行**过程中**产生（流式）
       * - updates 事件在节点执行**完成后**产生（汇总）
       * - processMessagesChunk 负责：逐字显示 AI 回复
       * - processUpdatesChunk 负责：检测工具调用、显示工具结果
       */
      const stream = await this.toolGraph.stream(
        { messages },
        {
          context,
          callbacks: [tracer],
          streamMode: ['messages', 'updates'],
          signal,
        },
      );

      for await (const chunk of stream) {
        if (signal.aborted) {
          this.logger.debug(
            `[Graph] 客户端断开，中止图执行，已耗时 ${Date.now() - startTime}ms`,
          );
          break;
        }

        // streamMode 为数组时，chunk 是元组 [mode, data]
        const [mode, data] = chunk as [string, unknown];

        if (mode === 'messages') {
          this.processMessagesChunk(data, subscriber);
        } else if (mode === 'updates') {
          this.processUpdatesChunk(data as Record<string, unknown>, subscriber);
        }
      }

      // 只有在信号未被外部中止（客户端未主动断开）的情况下，向客户端发送 DONE 事件，
      // 之所以不在 aborted 时发送 DONE，是为了保证客户端正确感知异常中断 vs. 正常结束。
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
    } catch (error) {
      if (signal.aborted) {
        this.logger.debug(
          `[Graph] 图执行已取消，耗时 ${Date.now() - startTime}ms`,
        );
        subscriber.complete();
        return;
      }

      this.logger.error(
        `[Graph] 流式执行失败，耗时 ${Date.now() - startTime}ms`,
        error,
      );
      subscriber.next({
        type: StreamChunkType.ERROR,
        error: error instanceof Error ? error.message : String(error),
      });
      subscriber.complete();
    }
  }

  /**
   * 处理 'messages' 模式的 chunk — token 级 AI 文本流式
   *
   * 'messages' 模式的 data 格式：[AIMessageChunk, metadata]
   * - AIMessageChunk：模型生成的单个 token（content 为该 token 的文本片段）
   * - metadata：{ langgraph_node: string, langgraph_step: number, ... }
   *
   * 只对有非空文本内容的 chunk 发射 TEXT 事件。
   * tool_call_chunks（工具调用的增量片段）在此处忽略，
   * 完整的 tool_calls 由 'updates' 模式在节点完成后提供。
   *
   * @param data - 'messages' 模式产出的原始数据，格式为 [AIMessageChunk, metadata] 元组
   * @param subscriber - RxJS Subscriber，接收处理后的 StreamChunk 事件
   */
  private processMessagesChunk(
    data: unknown,
    subscriber: Subscriber<StreamChunk>,
  ): void {
    // data 是 [AIMessageChunk, metadata] 元组
    const [message] = data as [BaseMessage, unknown];

    if (message instanceof AIMessageChunk) {
      const content =
        typeof message.content === 'string' ? message.content : '';
      // 只推送有实际文本内容的 token，跳过空 chunk（如纯 tool_call_chunks）
      if (content) {
        subscriber.next({
          type: StreamChunkType.TEXT,
          content,
        });
      }
    }
  }

  /**
   * 处理 'updates' 模式的 chunk — 节点级结构化事件
   *
   * 'updates' 模式的 chunk 格式：{ [nodeName]: { ...partialStateUpdate } }
   * - key: 刚执行完成的节点名称（如 'callModel', 'executeTools'）
   * - value: 该节点产生的状态增量（通常包含新增的消息数组）
   *
   * 职责划分：
   * - callModel 节点：只提取 tool_calls → 发射 TOOL_CALL 事件
   *   （AI 文本已由 'messages' 模式逐 token 推送，此处不再重复发射 TEXT）
   * - executeTools 节点：提取工具执行结果 → 发射 TOOL_RESULT 事件
   *
   * @example
   * // callModel 节点执行后的 chunk
   * {
   *   callModel: {
   *     messages: [AIMessage { content: '我来查天气', tool_calls: [...] }],
   *     iterationCount: 1
   *   }
   * }
   *
   * // executeTools 节点执行后的 chunk
   * {
   *   executeTools: {
   *     messages: [ToolMessage { content: '{"temp": 25}' }],
   *     toolCallCount: 1
   *   }
   * }
   *
   * @param chunk - 'updates' 模式产出的节点状态增量对象
   * @param subscriber - RxJS Subscriber，接收处理后的 StreamChunk 事件
   */
  private processUpdatesChunk(
    chunk: Record<string, unknown>,
    subscriber: Subscriber<StreamChunk>,
  ): void {
    // callModel 节点的输出：只提取 tool_calls
    if (chunk['callModel']) {
      // callModel 节点产出的状态更新，提取工具调用（tool_calls）
      const update = chunk['callModel'] as Record<string, unknown>;
      const messages = update['messages'] as BaseMessage[] | undefined;
      // 提取最后一条消息
      const lastMsg = messages?.[messages.length - 1];

      // 如果最后一条消息是 AIMessage 且有工具调用（tool_calls）
      if (lastMsg instanceof AIMessage && lastMsg.tool_calls?.length) {
        // 遍历本轮推理触发的每个工具调用，逐个发射 TOOL_CALL 事件
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
      // AI 文本内容已由 processMessagesChunk 逐 token 推送，此处不再发射 TEXT 事件
    }

    // executeTools 节点的输出
    if (chunk['executeTools']) {
      // executeTools 节点产出的状态更新，提取工具执行结果消息（ToolMessage）
      const update = chunk['executeTools'] as Record<string, unknown>;
      // 提取工具执行结果消息（ToolMessage）
      const messages = update['messages'] as BaseMessage[] | undefined;

      // 如果工具执行结果消息（ToolMessage）不为空
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
  }

  /**
   * 校验模型是否支持 tool calling
   *
   * 从 MODEL_REGISTRY 中查找模型定义，依据 capabilities.toolCalls 判断。
   * 未在注册表中声明的模型放行并记录警告。
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
          '无法使用工具调用功能。请切换到支持 tool calling 的模型。',
      );
    }
  }

  /**
   * 将 API 消息格式转为 LangChain BaseMessage[]
   *
   * @param messages - 来自 API 请求的用户级消息数组（符合内部 `Message` 接口）
   * @param systemPrompt - 可选的系统提示词字符串，如果提供，则会作为首条 SystemMessage 插入
   * @returns 转换后的 LangChain BaseMessage 数组，作为状态图初始消息的输入
   *
   * @example
   * // 参数示例
   * const messages = [
   *   { role: 'user', content: '北京今天天气怎么样？' },
   *   { role: 'assistant', content: '我来为您查询北京天气。' },
   *   { role: 'user', content: '谢谢' }
   * ];
   * const systemPrompt = '你是一个有用的助手';
   *
   * // 返回值示例
   * // [
   * //   SystemMessage { content: '你是一个有用的助手' },
   * //   HumanMessage { content: '北京今天天气怎么样？' },
   * //   AIMessage { content: '我来为您查询北京天气。' },
   * //   HumanMessage { content: '谢谢' }
   * // ]
   */
  private buildMessages(
    messages: Message[],
    systemPrompt?: string,
  ): BaseMessage[] {
    return convertToLangChainMessages(messages, systemPrompt);
  }

  /**
   * 从最后一条消息中提取文本内容
   *
   * @param message - LangGraph 执行完成后返回的最后一条 BaseMessage（通常是 AIMessage）
   * @returns 提取的纯文本内容。如果内容已经是字符串则直接返回，若是复杂结构则格式化为 JSON 字符串返回
   */
  private extractContent(message: BaseMessage): string {
    if (typeof message.content === 'string') return message.content;
    return JSON.stringify(message.content);
  }

  /**
   * 从消息中提取 token 使用统计
   *
   * @param message - LangGraph 执行完成后返回的最后一条 BaseMessage（包含 LLM 返回的 usage_metadata）
   * @returns 从消息中提取的 token 消耗统计信息（包含 prompt、completion 和总 tokens），如果消息中没有使用数据则返回 undefined
   */
  private extractUsage(
    message: BaseMessage,
  ): GraphInvokeResult['usage'] | undefined {
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
}
