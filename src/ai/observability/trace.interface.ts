/**
 * 可观测性数据结构
 *
 * 定义 LangChain 链路追踪的核心类型，用于结构化记录
 * LLM / Chain / Tool / Retriever 各环节的运行时指标。
 */

/**
 * 追踪 Span（单个操作的生命周期记录）
 *
 * 每次 LLM 调用、链执行、工具执行或检索操作都会产生一个 Span，
 * 记录其开始/结束时间、耗时、token 消耗和错误信息。
 */
export interface TraceSpan {
  /** LangChain 分配的运行 ID */
  runId: string;
  /** 父级运行 ID（用于构建调用树） */
  parentRunId?: string;
  /** 操作名称（模型名、链名、工具名等） */
  name: string;
  /** 操作类型 */
  type: 'llm' | 'chain' | 'tool' | 'retriever';
  /** 开始时间戳 (ms) */
  startTime: number;
  /** 结束时间戳 (ms) */
  endTime?: number;
  /** 耗时 (ms) */
  latencyMs?: number;
  /** Token 用量（仅 LLM 类型） */
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
  /** 错误信息（操作失败时记录） */
  error?: string;
  /** 附加元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 追踪摘要（单次请求的聚合指标）
 *
 * 将一次完整请求中的所有 Span 聚合为可读的摘要，
 * 供日志系统或监控面板消费。
 */
export interface TraceSummary {
  /** 全局追踪 ID（贯穿一次完整请求） */
  traceId: string;
  /** 请求总耗时 (ms) */
  totalLatencyMs: number;
  /** LLM 调用次数 */
  llmCallCount: number;
  /** LLM 调用总耗时 (ms) */
  llmTotalLatencyMs: number;
  /** 累计 Token 用量 */
  totalTokenUsage: {
    input: number;
    output: number;
    total: number;
  };
  /** 工具调用次数 */
  toolCallCount: number;
  /** 检索操作次数 */
  retrieverCallCount: number;
  /** 是否有错误发生 */
  hasError: boolean;
  /** 首个错误信息（快速定位） */
  firstError?: string;
  /** 所有 Span 详情 */
  spans: TraceSpan[];
}
