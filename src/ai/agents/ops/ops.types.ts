import type { AiProvider } from '../../constants';
import type { Message } from '../../interfaces';
import type { AgentMetrics } from '../../observability';

/**
 * Ops Operations 运维
 * Ops Agent 调用参数
 */
export interface OpsInvokeParams {
  /** AI 提供商 */
  provider: AiProvider | string;
  /** 模型名称 */
  model: string;
  /** 消息列表 */
  messages: Message[];
  /** 系统提示词（可选） */
  systemPrompt?: string;
  /** 温度参数 */
  temperature?: number;
  /** 最大输出 Token 数 */
  maxTokens?: number;
  /** 启用的子 Agent 名称列表（为空启用全部） */
  enabledAgents?: string[];

  // ── 运维能力开关 ──
  /** 是否启用熔断保护（默认 true） */
  enableCircuitBreaker?: boolean;
  /** 是否启用上下文压缩（默认 true） */
  enableCompaction?: boolean;
  /** 压缩策略 */
  compactionStrategy?: 'trim' | 'summarize';
  /** 是否启用输出守卫（默认 true） */
  enableOutputGuardrail?: boolean;
  /** 是否启用 PII 脱敏（默认 true） */
  enablePiiSanitization?: boolean;
}

/**
 * Ops Agent 调用结果
 */
export interface OpsInvokeResult {
  /** 最终响应内容 */
  content: string;
  /** 各 Agent 被委派的次数 */
  agentCalls: Record<string, number>;
  /** 总委派轮次 */
  totalDelegations: number;
  /** Token 使用统计 */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** 链路追踪摘要 */
  trace?: {
    traceId: string;
    totalLatencyMs: number;
    llmCallCount: number;
    totalTokens: number;
  };
  /** 运维指标报告 */
  metrics?: AgentMetrics;
  /** 输出守卫触发的规则列表 */
  guardrailTriggered?: string[];
  /** 是否执行了上下文压缩 */
  contextCompacted?: boolean;
}
