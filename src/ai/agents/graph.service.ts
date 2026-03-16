import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { Subject } from 'rxjs';

import { AiModelFactory } from '../factories/model.factory';
import { ToolRegistry } from '../tools/tool.registry';
import { LangChainTracer } from '../observability';
import { AiProvider, StreamChunkType } from '../constants';
import { MODEL_REGISTRY } from '../constants/model-registry';
import type { StreamChunk } from '../interfaces';
import {
  buildToolGraph,
  buildFunctionalToolAgent,
  type ToolGraphCompiled,
  type FunctionalToolAgent,
} from './single';
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
  /** Functional API 编译产物（单例） */
  private readonly functionalAgent: FunctionalToolAgent;

  constructor(
    private readonly modelFactory: AiModelFactory,
    private readonly toolRegistry: ToolRegistry,
    private readonly configService: ConfigService,
  ) {
    this.toolGraph = buildToolGraph();
    this.functionalAgent = buildFunctionalToolAgent();
    this.logger.log('ToolGraph (Graph API) 和 FunctionalToolAgent 已编译完成');
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
    this.validateToolCallingSupport(params.provider, params.model);
    const tracer = new LangChainTracer(this.logger);

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

    const context: ToolGraphContext = {
      model,
      tools,
      maxIterations: params.maxIterations ?? 5,
    };

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
  streamGraph(params: GraphInvokeParams): Subject<StreamChunk> {
    this.validateToolCallingSupport(params.provider, params.model);
    const subject = new Subject<StreamChunk>();
    void this.runGraphStream(params, subject);
    return subject;
  }

  /**
   * 通过 Functional API 执行工具调用（非流式）
   *
   * 与 Graph API 版本的功能等价，使用 entrypoint + task 过程式范式。
   * 展示同一逻辑在两种 API 下的不同表达方式。
   */
  async invokeFunctional(
    params: GraphInvokeParams,
  ): Promise<GraphInvokeResult> {
    this.validateToolCallingSupport(params.provider, params.model);
    const tracer = new LangChainTracer(this.logger);

    this.logger.log(
      `[Functional] 执行工具调用 Agent，提供商: ${params.provider}, 模型: ${params.model}, ` +
        `traceId: ${tracer.getTraceId()}`,
    );

    const model = this.modelFactory.createChatModel(params.provider, {
      model: params.model,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
    });

    const tools = this.toolRegistry.getTools(params.toolNames);
    const messages = this.buildMessages(params.messages, params.systemPrompt);

    const result = await this.functionalAgent.invoke(
      {
        messages,
        model,
        tools,
        maxIterations: params.maxIterations ?? 5,
      },
      {
        callbacks: [tracer],
      },
    );

    const traceSummary = tracer.logSummary();

    return {
      content: result.content,
      iterationCount: result.totalIterations,
      toolCallCount: result.toolCallCount,
      trace: {
        traceId: traceSummary.traceId,
        totalLatencyMs: traceSummary.totalLatencyMs,
        llmCallCount: traceSummary.llmCallCount,
        totalTokens: traceSummary.totalTokenUsage.total,
      },
    };
  }

  /**
   * 流式执行图
   */
  private async runGraphStream(
    params: GraphInvokeParams,
    subject: Subject<StreamChunk>,
  ): Promise<void> {
    const tracer = new LangChainTracer(this.logger);
    const startTime = Date.now();

    try {
      const model = this.modelFactory.createChatModel(params.provider, {
        model: params.model,
        streaming: true,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
      });

      const tools = this.toolRegistry.getTools(params.toolNames);
      const messages = this.buildMessages(params.messages, params.systemPrompt);

      const context: ToolGraphContext = {
        model,
        tools,
        maxIterations: params.maxIterations ?? 5,
      };

      /**
       * streamMode: "updates" 返回每个节点执行后的 State 增量更新，
       * 格式为 { [nodeName]: partialState }
       */
      const stream = await this.toolGraph.stream(
        { messages },
        {
          context,
          callbacks: [tracer],
          streamMode: 'updates',
        },
      );

      for await (const chunk of stream) {
        this.processStreamChunk(chunk as Record<string, unknown>, subject);
      }

      const traceSummary = tracer.logSummary();

      subject.next({
        type: StreamChunkType.DONE,
        trace: {
          traceId: traceSummary.traceId,
          totalLatencyMs: traceSummary.totalLatencyMs,
          llmCallCount: traceSummary.llmCallCount,
          llmTotalLatencyMs: traceSummary.llmTotalLatencyMs,
          totalTokens: traceSummary.totalTokenUsage.total,
        },
      });
      subject.complete();
    } catch (error) {
      this.logger.error(
        `[Graph] 流式执行失败，耗时 ${Date.now() - startTime}ms`,
        error,
      );
      subject.next({
        type: StreamChunkType.ERROR,
        error: error instanceof Error ? error.message : String(error),
      });
      subject.complete();
    }
  }

  /**
   * 处理 graph.stream("updates") 的单个 chunk
   *
   * updates 模式的 chunk 格式：{ [nodeName]: { ...partialStateUpdate } }
   * 将节点粒度的更新映射到 StreamChunk 事件。
   */
  private processStreamChunk(
    chunk: Record<string, unknown>,
    subject: Subject<StreamChunk>,
  ): void {
    // callModel 节点的输出
    if (chunk['callModel']) {
      const update = chunk['callModel'] as Record<string, unknown>;
      const messages = update['messages'] as BaseMessage[] | undefined;
      const lastMsg = messages?.[messages.length - 1];

      if (lastMsg instanceof AIMessage) {
        if (lastMsg.tool_calls?.length) {
          for (const tc of lastMsg.tool_calls) {
            subject.next({
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
        } else {
          subject.next({
            type: StreamChunkType.TEXT,
            content:
              typeof lastMsg.content === 'string'
                ? lastMsg.content
                : JSON.stringify(lastMsg.content),
          });
        }
      }
    }

    // executeTools 节点的输出
    if (chunk['executeTools']) {
      const update = chunk['executeTools'] as Record<string, unknown>;
      const messages = update['messages'] as BaseMessage[] | undefined;

      if (messages) {
        for (const msg of messages) {
          if (msg instanceof ToolMessage) {
            subject.next({
              type: StreamChunkType.TOOL_RESULT,
              toolResult: {
                toolCallId:
                  (msg as unknown as { tool_call_id?: string }).tool_call_id ??
                  '',
                name: (msg as unknown as { name?: string }).name ?? 'unknown',
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
   */
  private buildMessages(
    messages: Message[],
    systemPrompt?: string,
  ): BaseMessage[] {
    return convertToLangChainMessages(messages, systemPrompt);
  }

  /**
   * 从最后一条消息中提取文本内容
   */
  private extractContent(message: BaseMessage): string {
    if (typeof message.content === 'string') return message.content;
    return JSON.stringify(message.content);
  }

  /**
   * 从消息中提取 token 使用统计
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
