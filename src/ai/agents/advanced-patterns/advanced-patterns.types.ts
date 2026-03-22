import type { StepResult } from '../single/plan-execute-graph';

/**
 * Reflection 调用结果
 */
export interface ReflectionInvokeResult {
  /** 最终生成内容 */
  content: string;
  /** 实际反思轮次（0 = 首次生成即通过） */
  reflectionCount: number;
  /** 最终评估分数（0-10） */
  score?: number;
  /** 最终评估反馈 */
  feedback?: string;
  /** 评估是否通过（false 表示达到最大反思次数后强制返回） */
  passed: boolean;
  /** Token 使用统计 */
  usage?: TokenUsage;
  /** 链路追踪摘要 */
  trace?: TraceSummary;
}

/**
 * Plan-Execute 调用结果
 */
export interface PlanExecuteInvokeResult {
  /** 最终汇总响应 */
  content: string;
  /** 执行的计划步骤 */
  plan: string[];
  /** 各步骤的执行结果 */
  stepResults: StepResult[];
  /** Token 使用统计 */
  usage?: TokenUsage;
  /** 链路追踪摘要 */
  trace?: TraceSummary;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface TraceSummary {
  traceId: string;
  totalLatencyMs: number;
  llmCallCount: number;
  totalTokens: number;
}
