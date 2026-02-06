/**
 * 可复用 Node 函数导出
 *
 * 跨 Agent 共享的通用节点逻辑（如 LLM 调用节点、人工审批节点）。
 *
 * 示例：
 * export { callModelNode } from './call-model.node';
 * export { humanApprovalNode } from './human-approval.node';
 */
