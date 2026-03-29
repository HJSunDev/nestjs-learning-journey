import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import type { AgentMetrics } from './trace.interface';

/**
 * Agent 指标收集器
 *
 * 每次 Agent 请求创建一个实例，在请求生命周期内收集各维度的运行时指标，
 * 请求结束时调用 finalize() 生成聚合报告并写入日志。
 *
 * 设计决策（与 LangChainTracer 的关系）：
 * - LangChainTracer：细粒度 Span 级回调追踪（每个 LLM/Tool 调用的生命周期）
 * - AgentMetricsCollector：请求级聚合指标（面向监控仪表盘和告警规则）
 * - 两者互补：Tracer 提供诊断细节，Collector 提供运维概览
 * - Collector 非 NestJS 注入，而是 per-request 实例（同 Tracer）
 *
 * 使用方式：
 * ```typescript
 * const metrics = new AgentMetricsCollector('deepseek', 'deepseek-chat');
 * metrics.recordLlmCall(latencyMs, tokenUsage);
 * metrics.recordToolCall(latencyMs);
 * const report = metrics.finalize('success');
 * ```
 */
export class AgentMetricsCollector {
  private readonly logger: Logger;
  private readonly requestId: string;
  private readonly startedAt: number;

  private llmCallCount = 0;
  private llmTotalLatencyMs = 0;
  private toolCallCount = 0;
  private toolTotalLatencyMs = 0;
  private tokenInput = 0;
  private tokenOutput = 0;
  private retryCount = 0;
  private fallbackUsed = false;
  private contextCompacted = false;
  private compactionBefore = 0;
  private compactionAfter = 0;
  private guardrailTriggered: string[] = [];
  private circuitBreakerState?: string;

  constructor(
    private readonly provider: string,
    private readonly model: string,
    parentLogger?: Logger,
  ) {
    this.logger = parentLogger ?? new Logger('AgentMetricsCollector');
    this.requestId = uuidv4();
    this.startedAt = Date.now();
  }

  /**
   * 记录一次 LLM 调用
   *
   * @param latencyMs - 调用延迟（毫秒）
   * @param tokenUsage - Token 用量（可选，部分模型不返回）
   */
  recordLlmCall(
    latencyMs: number,
    tokenUsage?: { input: number; output: number },
  ): void {
    this.llmCallCount++;
    this.llmTotalLatencyMs += latencyMs;
    if (tokenUsage) {
      this.tokenInput += tokenUsage.input;
      this.tokenOutput += tokenUsage.output;
    }
  }

  /**
   * 记录一次工具调用
   *
   * @param latencyMs - 调用延迟（毫秒）
   */
  recordToolCall(latencyMs: number): void {
    this.toolCallCount++;
    this.toolTotalLatencyMs += latencyMs;
  }

  /**
   * 记录重试事件
   */
  recordRetry(): void {
    this.retryCount++;
  }

  /**
   * 记录降级事件
   */
  recordFallback(): void {
    this.fallbackUsed = true;
  }

  /**
   * 记录上下文压缩事件
   *
   * @param before - 压缩前消息数
   * @param after - 压缩后消息数
   */
  recordCompaction(before: number, after: number): void {
    this.contextCompacted = true;
    this.compactionBefore = before;
    this.compactionAfter = after;
  }

  /**
   * 记录输出守卫触发
   *
   * @param rules - 触发的规则名称列表
   */
  recordGuardrailTrigger(rules: string[]): void {
    this.guardrailTriggered.push(...rules);
  }

  /**
   * 记录熔断器状态
   *
   * @param state - 熔断器当前状态
   */
  recordCircuitBreakerState(state: string): void {
    this.circuitBreakerState = state;
  }

  /**
   * 从 LangChainTracer 的摘要中批量导入指标
   *
   * 避免在 Tracer 和 Collector 中重复收集相同数据。
   * Tracer 的 logSummary() 返回的 TraceSummary 可直接注入。
   *
   * @param summary - LangChainTracer 的追踪摘要
   */
  importFromTraceSummary(summary: {
    llmCallCount: number;
    llmTotalLatencyMs: number;
    toolCallCount: number;
    totalTokenUsage: { input: number; output: number };
  }): void {
    this.llmCallCount = summary.llmCallCount;
    this.llmTotalLatencyMs = summary.llmTotalLatencyMs;
    this.toolCallCount = summary.toolCallCount;
    this.tokenInput = summary.totalTokenUsage.input;
    this.tokenOutput = summary.totalTokenUsage.output;
  }

  /**
   * 完成收集并生成最终指标报告
   *
   * 聚合所有已记录的指标，计算总延迟，写入日志，返回结构化报告。
   *
   * @param status - 请求最终状态
   * @param error - 错误信息（失败时提供）
   * @returns 聚合后的 AgentMetrics
   */
  finalize(status: AgentMetrics['status'], error?: string): AgentMetrics {
    const completedAt = Date.now();
    const totalLatencyMs = completedAt - this.startedAt;

    const metrics: AgentMetrics = {
      requestId: this.requestId,
      startedAt: this.startedAt,
      completedAt,
      totalLatencyMs,
      llmCallCount: this.llmCallCount,
      llmTotalLatencyMs: this.llmTotalLatencyMs,
      toolCallCount: this.toolCallCount,
      toolTotalLatencyMs: this.toolTotalLatencyMs,
      tokenUsage: {
        input: this.tokenInput,
        output: this.tokenOutput,
        total: this.tokenInput + this.tokenOutput,
      },
      status,
      guardrailTriggered: this.guardrailTriggered,
      contextCompacted: this.contextCompacted,
      ...(this.contextCompacted && {
        compactionDelta: {
          before: this.compactionBefore,
          after: this.compactionAfter,
        },
      }),
      provider: this.provider,
      model: this.model,
      circuitBreakerState: this.circuitBreakerState,
      retryCount: this.retryCount,
      fallbackUsed: this.fallbackUsed,
      error,
    };

    // 写入结构化日志（JSON 格式，可被 ELK/Loki 等日志系统解析）
    this.logger.log({
      message: `Agent 指标报告 [${status}]`,
      ...metrics,
    });

    return metrics;
  }

  /**
   * 获取请求 ID（用于关联日志和追踪）
   */
  getRequestId(): string {
    return this.requestId;
  }
}
