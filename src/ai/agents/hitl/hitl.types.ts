import type { ToolCallInfo } from '../../interfaces';

/**
 * 人类审批动作枚举
 *
 * 对齐生产标准的二元决策模型：
 * - approve: 批准执行（可选携带修改后的参数，对齐 Claude Agent SDK 的 PermissionResultAllow(updated_input)）
 * - reject:  驳回执行（可选携带原因，对齐 OpenAI Agents SDK 的 reject({ message })）
 *
 * 设计决策：
 * 参数修改是 approve 的可选增强，而非独立动作。
 * Claude Code、Cursor 等生产级工具均采用二元审批（allow/deny），
 * Claude Agent SDK 通过 updated_input 在 allow 内支持参数修改。
 */
export enum ReviewAction {
  APPROVE = 'approve',
  REJECT = 'reject',
}

/**
 * 审批决策 — 审批人通过 resume 端点提交的决策结构
 *
 * 对齐 Claude Agent SDK 的 PermissionResultAllow / PermissionResultDeny 模式：
 * - approve 时可选携带 updatedInput（修改后的工具调用参数）
 * - reject 时可选携带 reason（驳回原因，模型在下一轮推理中可见）
 */
export interface ReviewDecision {
  /** 决策动作 */
  action: ReviewAction;
  /** 驳回原因（action=reject 时使用，模型会在下一轮推理中看到此反馈） */
  reason?: string;
  /**
   * 修改后的工具调用参数（action=approve 时可选）
   *
   * 不传时按模型原始参数执行；传入时用修改后的参数替换原始 tool_calls。
   * 对齐 Claude Agent SDK 的 PermissionResultAllow(updated_input=...) 模式。
   */
  updatedInput?: EditedToolCall[];
}

/**
 * 修改后的工具调用
 */
export interface EditedToolCall {
  /** 原始工具调用 ID */
  id: string;
  /** 工具名称 */
  name: string;
  /** 修改后的参数 */
  args: Record<string, unknown>;
}

/**
 * 单工具审批决策 — per-tool 粒度控制
 *
 * 对齐 OpenAI Agents SDK 的 interruptions 数组模式：
 * 每个工具调用可独立 approve/reject，由 toolCallId 关联。
 *
 * 使用场景：模型一次生成多个 tool_calls 时，审批人对不同工具有不同决策。
 */
export interface ToolCallDecision {
  /** 对应的工具调用 ID（来自中断载荷中的 toolCalls[].id） */
  toolCallId: string;
  /** 审批动作 */
  action: ReviewAction;
  /** 驳回原因（action=reject 时使用） */
  reason?: string;
  /** 修改后的参数（action=approve 时可选） */
  updatedArgs?: Record<string, unknown>;
}

/**
 * HITL resume 值的类型联合
 *
 * reviewToolCalls 节点内 interrupt() 的返回值类型。
 * 服务层根据客户端提交的审批模式构建对应的 resume 值：
 *
 * - ReviewDecision（批量模式）：所有工具统一 approve 或 reject
 * - ToolCallDecision[]（逐工具模式）：每个工具独立决策
 *
 * 节点通过检查 'action' in resumeValue 区分两种模式。
 */
export type HitlResumeValue = ReviewDecision | ToolCallDecision[];

/**
 * HITL 运行时配置 — 通过 contextSchema 注入图的 HITL 行为参数
 */
export interface HitlConfig {
  /** 是否启用人类审批（false 时 reviewToolCalls 节点直接放行） */
  enabled: boolean;
  /** 免审批工具列表（这些工具调用不触发 interrupt，直接执行） */
  autoApproveTools?: string[];
}

/**
 * interrupt() 暂停时写入 __interrupt__ 的载荷结构
 *
 * 此结构由 reviewToolCalls 节点生成，通过 interrupt() 传递给调用方。
 */
export interface InterruptValue {
  /** 中断类型标识 */
  type: 'tool_call_review';
  /** 待审批的工具调用列表 */
  toolCalls: ToolCallInfo[];
  /** 面向审批人的可读提示 */
  message: string;
}

/**
 * __interrupt__ 数组中单个中断条目的结构
 *
 * LangGraph 返回的 __interrupt__ 是数组，每个条目包含：
 * - value: interrupt() 传入的载荷
 * - id: 中断唯一标识（多中断场景用于匹配 resume 值）
 */
export interface InterruptEntry {
  value: InterruptValue;
  id?: string;
}

/**
 * HITL 调用结果 — 统一的返回类型（完成或中断）
 */
export interface HitlInvokeResult {
  /** 执行状态：completed=图正常完成；interrupted=在 interrupt() 处暂停 */
  status: 'completed' | 'interrupted';
  /** 线程 ID */
  threadId: string;

  /** Agent 最终文本响应（status=completed 时有值） */
  content?: string;
  /** 推理/思考内容 */
  reasoning?: string;
  /** 迭代轮次 */
  iterationCount?: number;
  /** 工具调用总次数 */
  toolCallCount?: number;
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

  /** 中断载荷（status=interrupted 时有值） */
  interrupt?: InterruptValue;
}
