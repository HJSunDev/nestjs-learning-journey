import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import type { LLMResult } from '@langchain/core/outputs';
import type { ChainValues } from '@langchain/core/utils/types';
import type { Document } from '@langchain/core/documents';
import { isGraphBubbleUp } from '@langchain/langgraph';
import { Logger } from '@nestjs/common';
import type { TraceSpan, TraceSummary } from './trace.interface';

/**
 * LangChain 链路追踪回调处理器
 *
 * 继承 @langchain/core 的 BaseCallbackHandler，自动拦截 LLM / Chain / Tool / Retriever
 * 各环节的生命周期事件，记录结构化的运行时指标。
 *
 * ## 核心机制
 *
 * 内部维护一个 `Map<runId, TraceSpan>` 作为请求生命周期内的**计算缓冲区**：
 * - `handleXxxStart()` → 向 Map 中写入一条 Span（记录开始时间）
 * - `handleXxxEnd()`   → 从 Map 中取出对应 Span，补充结束时间和耗时
 * - `handleXxxError()` → 从 Map 中取出对应 Span，补充错误信息
 * - `logSummary()`     → 聚合所有 Span → 输出到 Winston 日志（JSON 格式落盘）
 *
 * ## 存储模型：为什么 Map 不需要持久化
 *
 * Map 是**纯内存的临时聚合层**，随请求结束被 GC 回收。
 * 持久化由已有的 Winston 日志体系承担——`logSummary()` 将聚合指标以 JSON 格式
 * 写入 `logs/combined-%DATE%.log`，可供后续 ELK / Loki 等日志系统检索分析。
 *
 * 数据流：
 * ```
 * 请求开始 → new LangChainTracer() → Map 缓冲 Span
 *    → 链调用（LangChain 自动触发各 handle* 回调）
 *    → 请求结束 → logSummary() → Winston JSON 日志（持久化）
 *    → Tracer 实例被 GC 回收
 * ```
 *
 * ## 生产级演进路径
 *
 * 当前方案覆盖了可观测性的 L1（日志驱动）层级，足以满足大部分场景。
 * 后续演进方向：
 * - **L2 指标聚合**：将 latency / tokenUsage / errorRate 导出到 Prometheus，配置告警规则
 * - **L3 分布式追踪**：接入 OpenTelemetry SDK，将 Span 导出到 Jaeger/Zipkin，获得火焰图
 * - **L4 LLM 专用平台**：接入 LangSmith/Langfuse，存储完整的 prompt/response 用于评估和微调
 *
 * 每层演进只需替换 `logSummary()` 的输出目标，或新增一个并行的 CallbackHandler，
 * 不需要改动链或模型的任何代码——这正是回调架构的优势。
 *
 * ## 使用方式
 *
 * ```typescript
 * const tracer = new LangChainTracer(this.logger);
 * await chain.invoke(input, { callbacks: [tracer] });
 * const summary = tracer.logSummary(); // 聚合 → Winston 落盘 → 返回摘要
 * ```
 */
export class LangChainTracer extends BaseCallbackHandler {
  name = 'LangChainTracer';

  private readonly logger: Logger;
  private readonly traceId: string;
  private readonly spans = new Map<string, TraceSpan>();
  private readonly requestStartTime: number;

  constructor(logger: Logger, traceId?: string) {
    super();
    this.logger = logger;
    this.traceId =
      traceId ??
      `trace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.requestStartTime = Date.now();
  }

  /**
   * 获取本次追踪的 Trace ID
   */
  getTraceId(): string {
    return this.traceId;
  }

  // ============================================================
  // LLM 生命周期
  // ============================================================

  handleLLMStart(
    llm: Serialized,
    _prompts: string[],
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    const name = runName || this.extractName(llm) || 'LLM';
    this.startSpan(runId, parentRunId, name, 'llm');
    this.logger.debug(
      `[Trace:${this.traceId}] LLM 开始 → ${name} (runId=${this.shortId(runId)})`,
    );
  }

  handleLLMEnd(output: LLMResult, runId: string): void {
    const span = this.endSpan(runId);
    if (!span) return;

    // LLMResult.llmOutput 通常包含 tokenUsage 信息
    const tokenUsage = this.extractTokenUsageFromLLMResult(output);
    if (tokenUsage) {
      span.tokenUsage = tokenUsage;
    }

    this.logger.debug(
      `[Trace:${this.traceId}] LLM 完成 → ${span.name} ` +
        `(${span.latencyMs}ms` +
        `${tokenUsage ? `, tokens=${tokenUsage.total}` : ''})`,
    );
  }

  handleLLMError(error: Error, runId: string): void {
    const span = this.endSpan(runId, error.message);
    this.logger.warn(
      `[Trace:${this.traceId}] LLM 错误 → ${span?.name ?? runId}: ${error.message}`,
    );
  }

  // ============================================================
  // Chain 生命周期
  // ============================================================

  handleChainStart(
    chain: Serialized,
    _inputs: ChainValues,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    _runType?: string,
    runName?: string,
  ): void {
    const name = runName || this.extractName(chain) || 'Chain';
    this.startSpan(runId, parentRunId, name, 'chain');
    this.logger.debug(
      `[Trace:${this.traceId}] Chain 开始 → ${name} (runId=${this.shortId(runId)})`,
    );
  }

  handleChainEnd(_outputs: ChainValues, runId: string): void {
    const span = this.endSpan(runId);
    if (!span) return;

    this.logger.debug(
      `[Trace:${this.traceId}] Chain 完成 → ${span.name} (${span.latencyMs}ms)`,
    );
  }

  handleChainError(error: Error, runId: string): void {
    // GraphBubbleUp 是 LangGraph 的正常控制流异常（Handoff / interrupt），非真实错误
    if (isGraphBubbleUp(error)) {
      const span = this.endSpan(runId);
      this.logger.debug(
        `[Trace:${this.traceId}] Chain 控制流转移 → ${span?.name ?? runId}`,
      );
      return;
    }

    const span = this.endSpan(runId, error.message);
    this.logger.warn(
      `[Trace:${this.traceId}] Chain 错误 → ${span?.name ?? runId}: ${error.message}`,
    );
  }

  // ============================================================
  // Tool 生命周期
  // ============================================================

  handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    const name = runName || this.extractName(tool) || 'Tool';
    this.startSpan(runId, parentRunId, name, 'tool', {
      input: this.truncate(input, 200),
    });
    this.logger.debug(
      `[Trace:${this.traceId}] Tool 开始 → ${name} (runId=${this.shortId(runId)})`,
    );
  }

  handleToolEnd(output: string, runId: string): void {
    const span = this.endSpan(runId);
    if (!span) return;

    if (span.metadata) {
      span.metadata.output = this.truncate(output, 200);
    }

    this.logger.debug(
      `[Trace:${this.traceId}] Tool 完成 → ${span.name} (${span.latencyMs}ms)`,
    );
  }

  handleToolError(error: Error, runId: string): void {
    const span = this.endSpan(runId, error.message);
    this.logger.warn(
      `[Trace:${this.traceId}] Tool 错误 → ${span?.name ?? runId}: ${error.message}`,
    );
  }

  // ============================================================
  // Retriever 生命周期
  // ============================================================

  handleRetrieverStart(
    retriever: Serialized,
    query: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    const name = runName || this.extractName(retriever) || 'Retriever';
    this.startSpan(runId, parentRunId, name, 'retriever', {
      query: this.truncate(query, 200),
    });
    this.logger.debug(
      `[Trace:${this.traceId}] Retriever 开始 → ${name} (runId=${this.shortId(runId)})`,
    );
  }

  handleRetrieverEnd(documents: Document[], runId: string): void {
    const span = this.endSpan(runId);
    if (!span) return;

    if (span.metadata) {
      span.metadata.documentCount = documents.length;
    }

    this.logger.debug(
      `[Trace:${this.traceId}] Retriever 完成 → ${span.name} ` +
        `(${span.latencyMs}ms, ${documents.length} docs)`,
    );
  }

  handleRetrieverError(error: Error, runId: string): void {
    const span = this.endSpan(runId, error.message);
    this.logger.warn(
      `[Trace:${this.traceId}] Retriever 错误 → ${span?.name ?? runId}: ${error.message}`,
    );
  }

  // ============================================================
  // 聚合与查询
  // ============================================================

  /**
   * 获取本次追踪的聚合摘要
   *
   * 在链调用结束后调用，将所有 Span 聚合为可消费的结构化指标。
   */
  getSummary(): TraceSummary {
    const spans = Array.from(this.spans.values());

    const llmSpans = spans.filter((s) => s.type === 'llm');
    const toolSpans = spans.filter((s) => s.type === 'tool');
    const retrieverSpans = spans.filter((s) => s.type === 'retriever');
    const errorSpans = spans.filter((s) => s.error);

    const totalTokenUsage = llmSpans.reduce(
      (acc, s) => {
        if (s.tokenUsage) {
          acc.input += s.tokenUsage.input;
          acc.output += s.tokenUsage.output;
          acc.total += s.tokenUsage.total;
        }
        return acc;
      },
      { input: 0, output: 0, total: 0 },
    );

    return {
      traceId: this.traceId,
      totalLatencyMs: Date.now() - this.requestStartTime,
      llmCallCount: llmSpans.length,
      llmTotalLatencyMs: llmSpans.reduce(
        (sum, s) => sum + (s.latencyMs ?? 0),
        0,
      ),
      totalTokenUsage,
      toolCallCount: toolSpans.length,
      retrieverCallCount: retrieverSpans.length,
      hasError: errorSpans.length > 0,
      firstError: errorSpans[0]?.error,
      spans,
    };
  }

  /**
   * 输出追踪摘要日志
   *
   * 在链调用完成后调用，以 info 级别输出聚合指标，便于生产环境监控。
   */
  logSummary(): TraceSummary {
    const summary = this.getSummary();

    const parts = [
      `traceId=${summary.traceId}`,
      `totalMs=${summary.totalLatencyMs}`,
      `llmCalls=${summary.llmCallCount}`,
      `llmMs=${summary.llmTotalLatencyMs}`,
      `tokens=${summary.totalTokenUsage.total}` +
        `(in=${summary.totalTokenUsage.input},out=${summary.totalTokenUsage.output})`,
    ];

    if (summary.toolCallCount > 0) {
      parts.push(`tools=${summary.toolCallCount}`);
    }
    if (summary.retrieverCallCount > 0) {
      parts.push(`retrievals=${summary.retrieverCallCount}`);
    }
    if (summary.hasError) {
      parts.push(`error="${summary.firstError}"`);
    }

    this.logger.log(`[Trace] ${parts.join(' | ')}`);

    return summary;
  }

  // ============================================================
  // 内部方法
  // ============================================================

  private startSpan(
    runId: string,
    parentRunId: string | undefined,
    name: string,
    type: TraceSpan['type'],
    metadata?: Record<string, unknown>,
  ): void {
    this.spans.set(runId, {
      runId,
      parentRunId,
      name,
      type,
      startTime: Date.now(),
      metadata: metadata ?? {},
    });
  }

  private endSpan(runId: string, error?: string): TraceSpan | undefined {
    const span = this.spans.get(runId);
    if (!span) return undefined;

    span.endTime = Date.now();
    span.latencyMs = span.endTime - span.startTime;
    if (error) span.error = error;

    return span;
  }

  /**
   * 从 Serialized 对象中提取可读名称
   *
   * LangChain 的 Serialized 格式为 { id: ['langchain', 'chat_models', 'ChatDeepSeek'], ... }
   * 取最后一个元素作为可读名称。
   */
  private extractName(serialized: Serialized): string | undefined {
    if (serialized?.id && Array.isArray(serialized.id)) {
      return serialized.id[serialized.id.length - 1];
    }
    return undefined;
  }

  /**
   * 从 LLMResult 中提取 token 用量
   *
   * LangChain 的 LLMResult.llmOutput 结构因提供商而异，
   * 需做防御性提取。
   */
  private extractTokenUsageFromLLMResult(
    result: LLMResult,
  ): TraceSpan['tokenUsage'] | undefined {
    const llmOutput = result.llmOutput as Record<string, unknown> | undefined;
    if (!llmOutput) return undefined;

    // @langchain/openai 系列的 tokenUsage 格式
    const tokenUsage = llmOutput.tokenUsage as
      | Record<string, number>
      | undefined;
    if (tokenUsage) {
      return {
        input: tokenUsage.promptTokens ?? tokenUsage.input_tokens ?? 0,
        output: tokenUsage.completionTokens ?? tokenUsage.output_tokens ?? 0,
        total: tokenUsage.totalTokens ?? tokenUsage.total_tokens ?? 0,
      };
    }

    // estimatedTokenUsage 回退
    const estimated = llmOutput.estimatedTokenUsage as
      | Record<string, number>
      | undefined;
    if (estimated) {
      return {
        input: estimated.promptTokens ?? 0,
        output: estimated.completionTokens ?? 0,
        total: estimated.totalTokens ?? 0,
      };
    }

    return undefined;
  }

  // 完整的 UUID 过长，为提高控制台日志的可读性，截取前段即可满足基础的追踪和区分需求
  private shortId(runId: string): string {
    return runId.slice(0, 8);
  }

  // 为防止大段文本（如完整的 Prompt 或模型长响应）导致日志记录冗长且难以阅读，
  // 在日志或追踪记录输出前，需对超出安全长度的文本内容进行统一的截断处理
  private truncate(text: string, maxLength: number): string {
    return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
  }
}
