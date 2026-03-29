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

/**
 * Agent 运维指标（054 章节新增）
 * AgentMetrics 智能体指标
 *
 * 面向生产监控的聚合指标，覆盖 Agent 执行的四个维度：
 * - 性能：延迟分布、LLM 调用次数
 * - 成本：Token 消耗量
 * - 质量：任务完成状态、输出守卫触发情况
 * - 韧性：熔断器状态、重试次数、上下文压缩情况
 *
 * 设计用于序列化后写入日志/Prometheus，或通过 API 返回给前端仪表盘。
 */
export interface AgentMetrics {
  /** 请求级唯一标识 */
  requestId: string;
  /** 请求开始时间戳 (ms) */
  startedAt: number;
  /** 请求结束时间戳 (ms) */
  completedAt: number;
  /** 请求总耗时 (ms) */
  totalLatencyMs: number;

  // ── 性能维度 ──
  /** LLM 调用次数 */
  llmCallCount: number;
  /** LLM 总延迟 (ms)，可计算 LLM 占比 */
  llmTotalLatencyMs: number;
  /** 工具调用次数 */
  toolCallCount: number;
  /** 工具总延迟 (ms) */
  toolTotalLatencyMs: number;

  // ── 成本维度 ──
  /** Token 用量 */
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };
  /** 估算成本（可选，需要外部价格配置） */
  estimatedCostUsd?: number;

  // ── 质量维度 ──
  /** 任务执行状态 */
  status: 'success' | 'failed' | 'timeout' | 'circuit_broken';
  /** 输出守卫触发的规则列表 */
  guardrailTriggered: string[];
  /** 是否执行了上下文压缩 */
  contextCompacted: boolean;
  /** 压缩前后的消息数变化 */
  compactionDelta?: { before: number; after: number };

  // ── 韧性维度 ──
  /** 使用的 provider */
  provider: string;
  /** 使用的模型 */
  model: string;
  /** 熔断器在请求时的状态 */
  circuitBreakerState?: string;
  /** 重试次数（0 表示首次即成功） */
  retryCount: number;
  /** 是否触发了降级（使用了 fallback 模型） */
  fallbackUsed: boolean;

  /** 错误信息（失败时记录） */
  error?: string;
}
