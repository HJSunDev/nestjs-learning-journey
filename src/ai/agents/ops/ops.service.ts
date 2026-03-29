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
import { LangChainTracer, AgentMetricsCollector } from '../../observability';
import { AiProvider, StreamChunkType } from '../../constants';
import { MODEL_REGISTRY } from '../../constants/model-registry';
import type { StreamChunk } from '../../interfaces';
import { convertToLangChainMessages } from '../../utils';
import { ResilienceService, CircuitBreakerRegistry } from '../../resilience';
import { ContextCompactionService } from '../shared/compaction';
import { validateInput } from '../shared/guards';
import { validateOutput } from '../shared/guards';
import { buildResearchAgent, RESEARCH_AGENT_DEF } from '../multi/sub-agents';
import { buildCodeAgent, CODE_AGENT_DEF } from '../multi/sub-agents';
import { buildSupervisorPrompt } from '../multi/supervisor';
import type { AgentDefinition } from '../multi/multi-agent.types';
import type { OpsInvokeParams, OpsInvokeResult } from './ops.types';

/** 内置子 Agent 定义列表 */
const BUILTIN_AGENTS: AgentDefinition[] = [RESEARCH_AGENT_DEF, CODE_AGENT_DEF];

/**
 * 生产级 Agent 运维服务 — 054 Production Agent Operations
 *
 * 在 053 多智能体 Supervisor 编排能力之上叠加完整的生产运维层：
 *
 * 1. **输入守卫** (Input Guardrail) → validateInput：Prompt Injection 检测 + 消息限制
 * 2. **上下文压缩** (Context Compaction) → ContextCompactionService：长对话自动裁剪/摘要
 * 3. **熔断保护** (Circuit Breaker) → CircuitBreakerRegistry：per-provider 故障隔离
 * 4. **输出守卫** (Output Guardrail) → validateOutput：PII 脱敏 + 内容安全检测
 * 5. **全链路指标** (Agent Metrics) → AgentMetricsCollector：请求级运维指标收集
 *
 * 执行流水线（从请求入口到响应出口）：
 * ```
 * Request → InputGuardrail → ContextCompaction → CircuitBreaker(Supervisor)
 *         → OutputGuardrail → MetricsReport → Response
 * ```
 *
 * 架构决策：
 * - 不继承 MultiAgentService，而是组合复用其子 Agent 构建能力
 *   （避免覆盖 invoke/stream 方法导致 LSP 违反）
 * - 每个运维能力通过参数开关独立控制（enableCircuitBreaker、enableCompaction 等）
 * - MetricsCollector 是 per-request 实例（同 LangChainTracer），不走 DI
 */
@Injectable()
export class OpsService {
  private readonly logger = new Logger(OpsService.name);

  constructor(
    private readonly modelFactory: AiModelFactory,
    private readonly toolRegistry: ToolRegistry,
    private readonly configService: ConfigService,
    private readonly reasoningNormalizer: ReasoningNormalizer,
    private readonly resilienceService: ResilienceService,
    private readonly circuitBreakerRegistry: CircuitBreakerRegistry,
    private readonly compactionService: ContextCompactionService,
  ) {
    this.logger.log('OpsService 已初始化 — 生产级 Agent 运维');
  }

  // ============================================================
  // 非流式调用
  // ============================================================

  /**
   * 生产级多智能体非流式调用
   *
   * 完整执行流水线：输入守卫 → 上下文压缩 → 熔断保护 → Supervisor 执行
   * → 输出守卫 → 指标收集 → 返回结果。
   *
   * @param params - 运维 Agent 调用参数
   * @returns 运维 Agent 调用结果（含运维指标）
   * @throws {BadRequestException} 输入校验失败 / 模型不支持 tool calling
   * @throws {BrokenCircuitError} 熔断器处于 OPEN 状态时
   */
  async invoke(params: OpsInvokeParams): Promise<OpsInvokeResult> {
    this.validateToolCallingSupport(params.provider, params.model);

    // ① 输入守卫
    validateInput(params.messages);

    const metricsCollector = new AgentMetricsCollector(
      params.provider,
      params.model,
      this.logger,
    );

    // 记录熔断器状态
    const cbInfo = this.circuitBreakerRegistry.getInfo(params.provider);
    if (cbInfo) {
      metricsCollector.recordCircuitBreakerState(cbInfo.state);
    }

    try {
      // ② 上下文压缩
      const langchainMessages = convertToLangChainMessages(params.messages);
      const compactionResult =
        params.enableCompaction !== false
          ? await this.compactionService.compact(langchainMessages, {
              strategy: params.compactionStrategy,
              summaryModel:
                params.compactionStrategy === 'summarize'
                  ? this.modelFactory.createChatModel(params.provider, {
                      model: params.model,
                      temperature: 0.3,
                    })
                  : undefined,
            })
          : {
              messages: langchainMessages,
              compacted: false,
              originalCount: langchainMessages.length,
              compactedCount: langchainMessages.length,
              strategy: 'none' as const,
            };

      if (compactionResult.compacted) {
        metricsCollector.recordCompaction(
          compactionResult.originalCount,
          compactionResult.compactedCount,
        );
      }

      // ③ 构建 Supervisor
      const tracer = new LangChainTracer(this.logger);
      const model = this.modelFactory.createChatModel(params.provider, {
        model: params.model,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
      });

      const enabledAgents = this.getEnabledAgents(params.enabledAgents);
      const app = this.buildSupervisorApp(model, enabledAgents, params);

      // ④ 在熔断器保护下执行 Supervisor
      const executeFn = () =>
        app.invoke(
          { messages: compactionResult.messages },
          { callbacks: [tracer] },
        );

      const result =
        params.enableCircuitBreaker !== false
          ? await this.resilienceService.withCircuitBreaker(
              params.provider,
              executeFn,
            )
          : await executeFn();

      // ⑤ 构建响应
      const response = this.buildResult(result, tracer, params.provider);

      // ⑥ 输出守卫
      if (params.enableOutputGuardrail !== false) {
        const outputCheck = validateOutput(response.content, {
          enablePiiSanitization: params.enablePiiSanitization !== false,
        });

        if (!outputCheck.passed) {
          this.logger.warn(`输出守卫拦截: ${outputCheck.reason}`);
          response.content = '抱歉，响应内容触发了安全策略，无法返回原始内容。';
        } else if (outputCheck.sanitizedContent) {
          response.content = outputCheck.sanitizedContent;
        }

        if (outputCheck.triggeredRules.length > 0) {
          metricsCollector.recordGuardrailTrigger(outputCheck.triggeredRules);
          response.guardrailTriggered = outputCheck.triggeredRules;
        }
      }

      // ⑦ 从 Tracer 导入指标并最终化
      const tracerSummary = tracer.getSummary();
      metricsCollector.importFromTraceSummary({
        llmCallCount: tracerSummary.llmCallCount,
        llmTotalLatencyMs: tracerSummary.llmTotalLatencyMs,
        toolCallCount: tracerSummary.toolCallCount,
        totalTokenUsage: tracerSummary.totalTokenUsage,
      });

      response.metrics = metricsCollector.finalize('success');
      response.contextCompacted = compactionResult.compacted;

      return response;
    } catch (error) {
      const status = CircuitBreakerRegistry.isBrokenCircuitError(error)
        ? 'circuit_broken'
        : 'failed';
      metricsCollector.finalize(
        status,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }

  // ============================================================
  // 流式调用
  // ============================================================

  /**
   * 生产级多智能体流式调用
   *
   * 与非流式相同的运维流水线，但以 SSE 流式返回。
   * 输出守卫在流结束时对完整内容执行一次检查。
   *
   * @param params - 运维 Agent 调用参数
   * @returns StreamChunk 的 Observable 流
   */
  stream(params: OpsInvokeParams): Observable<StreamChunk> {
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
   */
  private async runStream(
    params: OpsInvokeParams,
    subscriber: Subscriber<StreamChunk>,
    signal: AbortSignal,
  ): Promise<void> {
    const metricsCollector = new AgentMetricsCollector(
      params.provider,
      params.model,
      this.logger,
    );

    try {
      // 上下文压缩
      const langchainMessages = convertToLangChainMessages(params.messages);
      const compactionResult =
        params.enableCompaction !== false
          ? await this.compactionService.compact(langchainMessages, {
              strategy: params.compactionStrategy,
            })
          : {
              messages: langchainMessages,
              compacted: false,
              originalCount: langchainMessages.length,
              compactedCount: langchainMessages.length,
              strategy: 'none' as const,
            };

      if (compactionResult.compacted) {
        metricsCollector.recordCompaction(
          compactionResult.originalCount,
          compactionResult.compactedCount,
        );
      }

      const tracer = new LangChainTracer(this.logger);
      const model = this.modelFactory.createChatModel(params.provider, {
        model: params.model,
        streaming: true,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
      });

      const enabledAgents = this.getEnabledAgents(params.enabledAgents);
      const app = this.buildSupervisorApp(model, enabledAgents, params);

      // 推送运维元信息
      subscriber.next({
        type: StreamChunkType.META,
        meta: {
          requestId: metricsCollector.getRequestId(),
          contextCompacted: compactionResult.compacted,
        },
      });

      // 在熔断器保护下创建流
      const createStream = () =>
        app.stream(
          { messages: compactionResult.messages },
          {
            callbacks: [tracer],
            streamMode: ['messages', 'updates'] as const,
            signal,
          },
        );

      const stream =
        params.enableCircuitBreaker !== false
          ? await this.resilienceService.withCircuitBreaker(
              params.provider,
              createStream,
            )
          : await createStream();

      // 收集完整输出用于输出守卫
      let fullContent = '';

      for await (const chunk of stream) {
        if (signal.aborted) break;

        const [mode, data] = chunk as [string, unknown];

        if (mode === 'messages') {
          const textContent = this.processMessagesChunk(data, subscriber);
          if (textContent) fullContent += textContent;
        } else if (mode === 'updates') {
          this.processUpdatesChunk(data as Record<string, unknown>, subscriber);
        }
      }

      // 输出守卫（对完整内容）
      if (params.enableOutputGuardrail !== false && fullContent) {
        const outputCheck = validateOutput(fullContent, {
          enablePiiSanitization: params.enablePiiSanitization !== false,
        });

        if (outputCheck.triggeredRules.length > 0) {
          metricsCollector.recordGuardrailTrigger(outputCheck.triggeredRules);
        }
      }

      if (!signal.aborted) {
        const summary = tracer.logSummary();
        const metrics = metricsCollector.finalize('success');

        subscriber.next({
          type: StreamChunkType.DONE,
          trace: {
            traceId: summary.traceId,
            totalLatencyMs: summary.totalLatencyMs,
            llmCallCount: summary.llmCallCount,
            llmTotalLatencyMs: summary.llmTotalLatencyMs,
            totalTokens: summary.totalTokenUsage.total,
          },
          meta: {
            metrics: {
              requestId: metrics.requestId,
              totalLatencyMs: metrics.totalLatencyMs,
              status: metrics.status,
              contextCompacted: metrics.contextCompacted,
              guardrailTriggered: metrics.guardrailTriggered,
            },
          },
        });
        subscriber.complete();
      }
    } catch (error) {
      const status = CircuitBreakerRegistry.isBrokenCircuitError(error)
        ? 'circuit_broken'
        : 'failed';
      metricsCollector.finalize(
        status,
        error instanceof Error ? error.message : String(error),
      );

      if (!signal.aborted) {
        subscriber.next({
          type: StreamChunkType.ERROR,
          error: error instanceof Error ? error.message : String(error),
        });
        subscriber.complete();
      }
    }
  }

  // ============================================================
  // 熔断器状态查询
  // ============================================================

  /**
   * 获取所有 provider 的熔断器状态
   *
   * @returns 熔断器状态列表
   */
  getCircuitBreakerStatus() {
    return this.circuitBreakerRegistry.getAllInfo();
  }

  /**
   * 重置指定 provider 的熔断器
   *
   * @param provider - AI 提供商标识
   */
  resetCircuitBreaker(provider: string): void {
    this.circuitBreakerRegistry.reset(provider);
  }

  // ============================================================
  // Supervisor 图构建（复用 053 的子 Agent 构建器）
  // ============================================================

  private buildSupervisorApp(
    model: ReturnType<AiModelFactory['createChatModel']>,
    enabledAgents: AgentDefinition[],
    params: OpsInvokeParams,
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
  // 结果构建与流式处理
  // ============================================================

  private buildResult(
    result: Record<string, unknown>,
    tracer: LangChainTracer,
    provider: string,
  ): OpsInvokeResult {
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

  /**
   * 处理 'messages' 模式的流式 chunk
   *
   * @returns 提取的文本内容（用于输出守卫累积）
   */
  private processMessagesChunk(
    data: unknown,
    subscriber: Subscriber<StreamChunk>,
  ): string | null {
    const [message] = data as [BaseMessage, unknown];
    if (!(message instanceof AIMessageChunk)) return null;
    if (message.tool_call_chunks && message.tool_call_chunks.length > 0) {
      return null;
    }

    const content = typeof message.content === 'string' ? message.content : '';
    if (content) {
      subscriber.next({ type: StreamChunkType.TEXT, content });
      return content;
    }
    return null;
  }

  /**
   * 处理 'updates' 模式的流式 chunk — 节点级事件
   */
  private processUpdatesChunk(
    data: Record<string, unknown>,
    subscriber: Subscriber<StreamChunk>,
  ): void {
    for (const [nodeName, nodeData] of Object.entries(data)) {
      if (nodeName === '__start__' || nodeName === '__end__') continue;

      const nodeMessages = (nodeData as Record<string, unknown>)?.[
        'messages'
      ] as BaseMessage[] | undefined;
      if (!nodeMessages || nodeMessages.length === 0) continue;

      for (const msg of nodeMessages) {
        // 工具调用请求
        if (msg instanceof AIMessage && msg.tool_calls?.length) {
          for (const tc of msg.tool_calls) {
            subscriber.next({
              type: StreamChunkType.TOOL_CALL,
              toolCall: {
                id: tc.id ?? '',
                name: tc.name,
                arguments: tc.args as Record<string, unknown>,
              },
            });
          }
        }

        // 工具执行结果
        if (msg instanceof ToolMessage) {
          subscriber.next({
            type: StreamChunkType.TOOL_RESULT,
            toolResult: {
              toolCallId: msg.tool_call_id,
              name: msg.name ?? 'unknown',
              result: msg.content,
            },
          });
        }
      }
    }
  }

  // ============================================================
  // 工具方法
  // ============================================================

  private getEnabledAgents(names?: string[]): AgentDefinition[] {
    if (!names || names.length === 0) return BUILTIN_AGENTS;
    return BUILTIN_AGENTS.filter((def) => names.includes(def.name));
  }

  private countAgentCalls(messages: BaseMessage[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const msg of messages) {
      if (msg instanceof ToolMessage) {
        const name = msg.name ?? '';
        if (name.startsWith('transfer_to_')) {
          const agentName = name.replace('transfer_to_', '');
          counts[agentName] = (counts[agentName] ?? 0) + 1;
        }
      }
    }
    return counts;
  }

  private extractUsage(message: BaseMessage) {
    const metadata = (message as AIMessage).response_metadata;
    const usage = metadata?.['usage'] as Record<string, number> | undefined;
    if (!usage) return undefined;
    return {
      promptTokens: usage['prompt_tokens'] ?? 0,
      completionTokens: usage['completion_tokens'] ?? 0,
      totalTokens: usage['total_tokens'] ?? 0,
    };
  }

  private validateToolCallingSupport(provider: string, model: string): void {
    const modelDef = MODEL_REGISTRY.find(
      (m) => m.id === model && m.provider === (provider as AiProvider),
    );

    if (!modelDef) {
      this.logger.warn(`模型 "${model}" 未在 MODEL_REGISTRY 中注册，跳过预检`);
      return;
    }

    if (!modelDef.capabilities.toolCalls) {
      throw new BadRequestException(
        `模型 "${modelDef.name}"（${model}）不支持 Tool Calling，无法用于多智能体编排`,
      );
    }
  }
}
