/**
 * 多智能体协作 Workflow 导出
 *
 * 每个 Workflow 独占一个文件夹，包含：
 * - <name>.graph.ts     Supervisor / Workflow 图定义
 * - sub-agents.ts       组成此 Workflow 的子 Agent 引用
 * - <name>.state.ts     Workflow 级别的共享 State
 * - index.ts            Barrel 导出
 *
 * 示例：
 * export { ResearchTeamWorkflow } from './research-team/research-team.graph';
 */
