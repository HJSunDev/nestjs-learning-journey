/**
 * 韧性配置类型
 *
 * 定义重试和降级策略的配置结构，
 * 供 ResilienceService 和 ChatChainBuilder 消费。
 */

/**
 * 重试策略配置
 *
 * 控制链调用失败时的自动重试行为。
 * LangChain 的 .withRetry() 内部使用指数退避算法：
 * 延迟 = min(初始间隔 * 2^(尝试次数-1), 最大间隔)
 */
export interface RetryPolicy {
  /** 最大重试次数（不含首次调用，默认 2 即总共调用 3 次） */
  maxAttempts: number;
}

/**
 * 降级（Fallback）配置
 *
 * 当主模型调用失败且重试耗尽后，自动切换到备用模型。
 * 常见策略：
 * - 同提供商换模型（如 deepseek-chat → deepseek-v2）
 * - 换提供商（如 deepseek → siliconflow）
 */
export interface FallbackConfig {
  /** 备用提供商标识 */
  provider: string;
  /** 备用模型 ID（不指定则使用该提供商的默认模型） */
  model?: string;
}

/**
 * 完整韧性配置
 *
 * 组合重试和降级策略，由调用方按需传入。
 */
export interface ResilienceOptions {
  /** 重试策略（未指定则不重试） */
  retry?: RetryPolicy;
  /** 降级链列表（按优先级排序，前面的优先尝试） */
  fallbacks?: FallbackConfig[];
}

/**
 * 熔断器策略配置
 *
 * 基于 cockatiel 的 ConsecutiveBreaker：
 * 连续失败达到阈值后开启熔断，快速失败避免向已故障的提供商发送请求。
 * halfOpenAfter 时间后进入半开状态，允许一个探测请求检查恢复情况。
 *
 * 与 LangChain .withRetry() 的协作关系：
 * 熔断器包裹在重试外层 → 重试耗尽后若仍失败则熔断器计数 +1 → 熔断后所有请求快速失败。
 */
export interface CircuitBreakerPolicy {
  /** 连续失败多少次后触发熔断（默认 5） */
  consecutiveFailures: number;
  /** 熔断后多久（毫秒）进入半开状态尝试恢复（默认 30 秒） */
  halfOpenAfterMs: number;
}

/**
 * 默认重试策略
 *
 * 重试 2 次（总共 3 次调用）适用于大部分 LLM API 的瞬时错误（如 429、502）。
 * 过多重试会增加延迟和成本，对于 LLM 场景不建议超过 3 次。
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 2,
};

/**
 * 默认熔断器策略
 *
 * 连续 5 次失败后熔断，30 秒后尝试恢复。
 * 对 LLM API 场景，30 秒已足够等待临时性故障恢复。
 */
export const DEFAULT_CIRCUIT_BREAKER_POLICY: CircuitBreakerPolicy = {
  consecutiveFailures: 5,
  halfOpenAfterMs: 30_000,
};
