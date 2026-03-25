import type { Message } from '../../interfaces';

/**
 * 子 Agent 定义
 *
 * 描述一个专业化子智能体的元数据，Supervisor 据此决定任务路由。
 */
export interface AgentDefinition {
  /** 唯一标识，同时作为图节点名（snake_case） */
  name: string;
  /** 自然语言能力描述，注入 Supervisor 提示词帮助 LLM 路由 */
  description: string;
  /** 此 Agent 可用的工具名称列表 */
  toolNames: string[];
  /** Agent 专属系统提示词 */
  systemPrompt: string;
}

/**
 * 多智能体调用参数
 */
export interface MultiAgentInvokeParams {
  provider: string;
  model: string;
  messages: Message[];
  /** 自定义 Supervisor 系统提示词（追加到默认提示词之后） */
  systemPrompt?: string;
  /** 最大委派轮次（防止无限循环） */
  maxDelegations?: number;
  temperature?: number;
  maxTokens?: number;
  /** 自定义启用的子 Agent 名称列表（空 = 全部启用） */
  enabledAgents?: string[];
}

/**
 * 多智能体调用结果
 */
export interface MultiAgentInvokeResult {
  /** 最终响应内容 */
  content: string;
  /** 各 Agent 被委派的次数 */
  agentCalls: Record<string, number>;
  /** 总委派轮次 */
  totalDelegations: number;
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
