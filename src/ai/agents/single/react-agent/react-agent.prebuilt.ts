import { createAgent } from 'langchain';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredToolInterface } from '@langchain/core/tools';

/**
 * 使用 LangChain createAgent 创建 ReAct 智能体
 *
 * createAgent 是 createReactAgent（@langchain/langgraph/prebuilt，已废弃）的继任者，
 * 于 langchain@1.x 中作为顶层 API 提供。
 *
 * 内部仍构建与 047 自建图相同的 StateGraph 拓扑：
 * START → agent 节点 → conditional → tools 节点 / END → agent 节点（循环）
 *
 * 与自建图的差异：
 * - 节点命名：prebuilt 用 "agent"/"tools"，自建用 "callModel"/"executeTools"
 * - 工具执行：prebuilt 固定并行（ToolNode），自建支持 parallel（默认并行）/sequential（逐个执行） 策略切换
 * - model 绑定：prebuilt 在创建时固定 model/tools，自建通过 contextSchema 运行时注入
 * - 迭代限制：prebuilt 不内置 maxIterations，自建通过 shouldContinue 控制
 *
 * 局限性（本项目场景）：
 * - model 和 tools 在创建时固定，不支持 contextSchema 运行时动态切换
 * - 每次 provider/model 变化需要重新创建，有微小性能开销
 * - 无内置 maxIterations 保护，需要外部通过 recursionLimit 控制
 *
 * @param model - LangChain Chat Model 实例（已由 AiModelFactory 创建）
 * @param tools - 工具列表（已由 ToolRegistry 提供）
 * @returns ReactAgent 实例，可直接 invoke/stream
 */
export function buildPrebuiltReactAgent(
  model: BaseChatModel,
  tools: StructuredToolInterface[],
) {
  return createAgent({
    model,
    tools,
  });
}

/**
 * Prebuilt ReAct Agent 编译产物类型
 */
export type PrebuiltReactAgentCompiled = ReturnType<
  typeof buildPrebuiltReactAgent
>;
