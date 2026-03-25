import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AIMessage,
  AIMessageChunk,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { createSupervisor } from '@langchain/langgraph-supervisor';
import { Observable, type Subscriber } from 'rxjs';

import { AiModelFactory } from '../../factories/model.factory';
import { ToolRegistry } from '../../tools/tool.registry';
import { ReasoningNormalizer } from '../../normalizers/reasoning.normalizer';
import { LangChainTracer } from '../../observability';
import { AiProvider, StreamChunkType } from '../../constants';
import { MODEL_REGISTRY } from '../../constants/model-registry';
import type { StreamChunk } from '../../interfaces';
import { convertToLangChainMessages } from '../../utils';

import { buildResearchAgent, RESEARCH_AGENT_DEF } from './sub-agents';
import { buildCodeAgent, CODE_AGENT_DEF } from './sub-agents';
import { buildSupervisorPrompt } from './supervisor';
import type {
  AgentDefinition,
  MultiAgentInvokeParams,
  MultiAgentInvokeResult,
} from './multi-agent.types';
import { validateInput } from '../shared/guards';

/** 内置子 Agent 定义列表 */
const BUILTIN_AGENTS: AgentDefinition[] = [RESEARCH_AGENT_DEF, CODE_AGENT_DEF];

/**
 * 多智能体协作服务 — 053 Multi-Agent Architecture
 *
 * 基于 @langchain/langgraph-supervisor 的 Supervisor 编排模式：
 * - 使用 createSupervisor 创建工具型 Handoff 路由
 * - Supervisor 通过 transfer_to_<agent> 工具将任务委派给子 Agent
 * - 子 Agent 完成后自动返回 Supervisor（addHandoffBackMessages）
 * - Supervisor 审查结果后决定继续委派或直接回复用户
 *
 * 架构决策：
 * - 子 Agent 在每次请求时动态创建（model/tools 随请求变化）
 * - createAgent (langchain) 构建子 Agent，通过 .graph 获取 CompiledStateGraph
 * - 支持 enabledAgents 按需启用/禁用子 Agent
 */
@Injectable()
export class MultiAgentService {
  private readonly logger = new Logger(MultiAgentService.name);

  constructor(
    private readonly modelFactory: AiModelFactory,
    private readonly toolRegistry: ToolRegistry,
    private readonly configService: ConfigService,
    private readonly reasoningNormalizer: ReasoningNormalizer,
  ) {
    this.logger.log('MultiAgentService 已初始化');
  }

  // ============================================================
  // 非流式调用
  // ============================================================

  /**
   * 多智能体 Supervisor 非流式调用
   *
   * 执行流程：
   * 1. 为每个子 Agent 调用 createAgent 构建 ReactAgent，取 .graph 获取 CompiledStateGraph
   * 2. 调用 createSupervisor 组装 Supervisor 图（自动生成 transfer_to_<name> Handoff 工具）
   * 3. 编译并执行
   *
   * @param params - 多智能体调用参数
   * @returns 多智能体调用结果
   * @throws {BadRequestException} 当模型不支持 tool calling 时
   */
  async invoke(
    params: MultiAgentInvokeParams,
  ): Promise<MultiAgentInvokeResult> {
    this.validateToolCallingSupport(params.provider, params.model);
    validateInput(params.messages);

    const tracer = new LangChainTracer(this.logger);

    this.logger.log(
      `[MultiAgent] 启动，提供商: ${params.provider}, 模型: ${params.model}`,
    );

    const model = this.modelFactory.createChatModel(params.provider, {
      model: params.model,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
    });

    const enabledAgents = this.getEnabledAgents(params.enabledAgents);
    const app = this.buildSupervisorApp(model, enabledAgents, params);
    const messages = convertToLangChainMessages(params.messages);

    const result = await app.invoke({ messages }, { callbacks: [tracer] });

    return this.buildResult(result, tracer, params.provider);
  }

  // ============================================================
  // 流式调用
  // ============================================================

  /**
   * 多智能体 Supervisor 流式调用
   *
   * @param params - 多智能体调用参数
   * @returns StreamChunk 的 Observable 流
   * @throws {BadRequestException} 当模型不支持 tool calling 时
   */
  stream(params: MultiAgentInvokeParams): Observable<StreamChunk> {
    this.validateToolCallingSupport(params.provider, params.model);
    validateInput(params.messages);

    return new Observable<StreamChunk>((subscriber) => {
      const abortController = new AbortController();
      void this.runStream(params, subscriber, abortController.signal);
      return () => abortController.abort();
    });
  }

  /**
   * 流式执行内部实现
   *
   * 双模式流式：streamMode: ['messages', 'updates']
   *
   * - 'messages' 模式：token 级流式，模型生成时逐 token 推送 TEXT 事件
   * - 'updates' 模式：节点级事件，节点执行完成后推送结构化状态
   *   （Supervisor 的 transfer_to_<agent> 委派、子 Agent 完成等）
   */
  private async runStream(
    params: MultiAgentInvokeParams,
    subscriber: Subscriber<StreamChunk>,
    signal: AbortSignal,
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

      const enabledAgents = this.getEnabledAgents(params.enabledAgents);
      const app = this.buildSupervisorApp(model, enabledAgents, params);
      const messages = convertToLangChainMessages(params.messages);

      subscriber.next({ type: StreamChunkType.META, meta: {} });

      const stream = await app.stream(
        { messages },
        {
          callbacks: [tracer],
          streamMode: ['messages', 'updates'] as const,
          signal,
        },
      );

      for await (const chunk of stream) {
        if (signal.aborted) break;

        // streamMode 为数组时，chunk 是元组 [mode, data]
        const [mode, data] = chunk as [string, unknown];

        if (mode === 'messages') {
          this.processMessagesChunk(data, subscriber);
        } else if (mode === 'updates') {
          this.processUpdatesChunk(data as Record<string, unknown>, subscriber);
        }
      }

      this.emitDone(signal, tracer, subscriber);
    } catch (error) {
      this.handleStreamError(error, signal, startTime, subscriber);
    }
  }

  // ============================================================
  // Supervisor 图构建
  // ============================================================

  /**
   * 构建并编译 Supervisor 应用
   *
   * createSupervisor 内部为每个子 Agent 自动生成 transfer_to_<name> 工具。
   * Supervisor LLM 调用该工具时，工具返回 Command({ goto, graph: Command.PARENT })，
   * LangGraph 运行时据此路由到目标 Agent 节点。
   *
   * @param model - LLM 实例（Supervisor 和子 Agent 共用）
   * @param enabledAgents - 启用的子 Agent 定义列表
   * @param params - 调用参数（用于提取 systemPrompt）
   * @returns 编译后的 Supervisor 图
   */
  private buildSupervisorApp(
    model: ReturnType<AiModelFactory['createChatModel']>,
    enabledAgents: AgentDefinition[],
    params: MultiAgentInvokeParams,
  ) {
    const agentGraphs = enabledAgents.map((def) => {
      const tools = this.toolRegistry.getTools(def.toolNames);
      if (def.name === CODE_AGENT_DEF.name) return buildCodeAgent(model, tools);
      return buildResearchAgent(model, tools);
    });

    const supervisorPrompt = buildSupervisorPrompt(
      enabledAgents,
      params.systemPrompt,
    );

    const workflow = createSupervisor({
      agents: agentGraphs as Parameters<typeof createSupervisor>[0]['agents'],
      llm: model,
      prompt: supervisorPrompt,
      outputMode: 'full_history',
    });

    return workflow.compile();
  }

  // ============================================================
  // 结果构建
  // ============================================================

  /**
   * 从图执行结果构建统一响应
   */
  private buildResult(
    result: Record<string, unknown>,
    tracer: LangChainTracer,
    provider: string,
  ): MultiAgentInvokeResult {
    const traceSummary = tracer.logSummary();
    const messages = result['messages'] as BaseMessage[];
    const lastMessage = messages[messages.length - 1];

    const normalized = this.reasoningNormalizer.normalize(
      provider,
      lastMessage as unknown as Record<string, unknown>,
    );

    const agentCalls = this.countAgentCalls(messages);
    const totalDelegations = Object.values(agentCalls).reduce(
      (sum, count) => sum + count,
      0,
    );

    return {
      content: normalized.content,
      agentCalls,
      totalDelegations,
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
  // 流式处理
  // ============================================================

  /**
   * 处理 'messages' 模式的 chunk — token 级流式事件
   *
   * data 格式: [BaseMessage, metadata]
   *
   * createSupervisor 的 messages 流会穿透子图，产出以下类型的消息：
   * - AIMessageChunk (tool_call_chunks) → 委派调用 / 工具调用
   * - AIMessageChunk (text content)     → 文本流式输出
   * - ToolMessage                       → 工具执行结果
   */
  private processMessagesChunk(
    data: unknown,
    subscriber: Subscriber<StreamChunk>,
  ): void {
    const [message] = data as [BaseMessage, unknown];

    // 工具执行结果（子 Agent 调用 getWeather/codeInterpreter 等工具后的返回）
    if (message instanceof ToolMessage) {
      subscriber.next({
        type: StreamChunkType.TOOL_RESULT,
        toolResult: {
          toolCallId: message.tool_call_id,
          name: message.name ?? 'unknown',
          result:
            typeof message.content === 'string'
              ? message.content
              : JSON.stringify(message.content),
        },
      });
      return;
    }

    if (!(message instanceof AIMessageChunk)) return;

    // tool_call_chunks：流式增量的工具调用片段
    // 只在首个 chunk（带 name 字段）时发射事件，后续 args 片段忽略
    if (message.tool_call_chunks?.length) {
      for (const tc of message.tool_call_chunks) {
        if (!tc.name) continue;

        const transferMatch = tc.name.match(/^transfer_to_(.+)$/);
        if (transferMatch) {
          // Supervisor → 子 Agent 委派
          subscriber.next({
            type: StreamChunkType.META,
            meta: { status: 'delegating', agent: transferMatch[1] },
          });
        } else {
          // 子 Agent → 工具调用
          subscriber.next({
            type: StreamChunkType.TOOL_CALL,
            toolCall: {
              id: tc.id ?? `tc_${Date.now()}`,
              name: tc.name,
              arguments: {},
            },
          });
        }
      }
      return;
    }

    // 纯文本 token
    const content = typeof message.content === 'string' ? message.content : '';
    if (!content || !content.trim()) return;

    subscriber.next({ type: StreamChunkType.TEXT, content });
  }

  /**
   * 处理 'updates' 模式的 chunk — 节点级结构化事件
   *
   * updates 事件在节点执行完成后产出，用于检测子 Agent 完成状态。
   * 文本和工具调用已由 processMessagesChunk 实时处理，此处不重复。
   */
  private processUpdatesChunk(
    chunk: Record<string, unknown>,
    subscriber: Subscriber<StreamChunk>,
  ): void {
    for (const [nodeName, update] of Object.entries(chunk)) {
      if (nodeName === 'supervisor' || !update || typeof update !== 'object')
        continue;

      // 子 Agent 节点完成
      subscriber.next({
        type: StreamChunkType.META,
        meta: { status: 'agent_completed', agent: nodeName },
      });
    }
  }

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

  private handleStreamError(
    error: unknown,
    signal: AbortSignal,
    startTime: number,
    subscriber: Subscriber<StreamChunk>,
  ): void {
    if (signal.aborted) {
      this.logger.debug(
        `[MultiAgent] 流式执行已取消，耗时 ${Date.now() - startTime}ms`,
      );
      subscriber.complete();
      return;
    }

    this.logger.error(
      `[MultiAgent] 流式执行失败，耗时 ${Date.now() - startTime}ms`,
      error,
    );
    subscriber.next({
      type: StreamChunkType.ERROR,
      error: error instanceof Error ? error.message : String(error),
    });
    subscriber.complete();
  }

  // ============================================================
  // 工具方法
  // ============================================================

  /**
   * 从消息历史中统计 Supervisor 对各 Agent 的实际委派次数
   *
   * 统计 Supervisor 产生的 transfer_to_<name> 工具调用数量，
   * 而非子 Agent 内部 ReAct 迭代产生的 AIMessage 数量，
   * 以准确反映 Handoff 次数。
   */
  private countAgentCalls(messages: BaseMessage[]): Record<string, number> {
    const counts: Record<string, number> = {};

    for (const msg of messages) {
      if (!(msg instanceof AIMessage) || !msg.tool_calls?.length) continue;

      for (const tc of msg.tool_calls) {
        const match = tc.name.match(/^transfer_to_(.+)$/);
        if (match) {
          const agentName = match[1];
          counts[agentName] = (counts[agentName] || 0) + 1;
        }
      }
    }

    return counts;
  }

  /**
   * 获取已启用的子 Agent 定义
   *
   * @param enabledNames - 客户端指定的 Agent 名称列表，为空则启用全部
   * @returns 筛选后的 AgentDefinition 列表
   * @throws {BadRequestException} 当指定的 Agent 名称不存在时
   */
  private getEnabledAgents(enabledNames?: string[]): AgentDefinition[] {
    if (!enabledNames?.length) return BUILTIN_AGENTS;

    const enabled = BUILTIN_AGENTS.filter((a) => enabledNames.includes(a.name));

    if (enabled.length === 0) {
      const available = BUILTIN_AGENTS.map((a) => a.name).join(', ');
      throw new BadRequestException(
        `未找到指定的 Agent: [${enabledNames.join(', ')}]，可用: [${available}]`,
      );
    }

    return enabled;
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
        `模型 "${modelId}" 未在 MODEL_REGISTRY 中注册，跳过预检`,
      );
      return;
    }

    if (!modelDef.capabilities.toolCalls) {
      throw new BadRequestException(
        `模型 "${modelDef.name}"（${modelId}）不支持 tool calling，` +
          '无法使用 Multi-Agent Supervisor。',
      );
    }
  }

  private extractUsage(
    message: BaseMessage,
  ): MultiAgentInvokeResult['usage'] | undefined {
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
