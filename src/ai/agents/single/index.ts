/**
 * 单智能体导出
 *
 * 每个 Agent 独占一个文件夹，包含：
 * - <name>.state.ts    State Annotation 定义
 * - <name>.nodes.ts    Node 函数（图中每个节点的逻辑）
 * - <name>.graph.ts    StateGraph 组装（节点 + 边 = 图）
 * - <name>.agent.ts    NestJS Injectable 包装（对外暴露 invoke/stream）
 * - index.ts           Barrel 导出
 *
 * 示例：
 * export { CodeReviewerAgent } from './code-reviewer/code-reviewer.agent';
 * export { TranslatorAgent } from './translator/translator.agent';
 */
