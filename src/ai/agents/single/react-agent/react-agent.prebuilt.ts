import { createReactAgent } from '@langchain/langgraph/prebuilt';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredToolInterface } from '@langchain/core/tools';

/**
 * 使用 LangGraph prebuilt createReactAgent 创建 ReAct 智能体
 *
 * createReactAgent 内部做了什么（源码级理解）：
 *
 * 1. 创建 StateGraph<MessagesAnnotation>
 * 2. 添加 "agent" 节点 — 调用 model.bindTools(tools).invoke(messages)
 * 3. 添加 "tools" 节点 — ToolNode 并行执行所有 tool_calls
 * 4. START → agent
 * 5. agent → conditionalEdge → tools（有 tool_calls）/ END（无 tool_calls）
 * 6. tools → agent
 * 7. compile()
 *
 * 与 047 自建图的差异：
 * - 节点命名：prebuilt 用 "agent"/"tools"，自建用 "callModel"/"executeTools"
 * - 工具执行：prebuilt 用 ToolNode（并行执行），自建逐个串行执行
 * - model 绑定：prebuilt 在创建时固定 model/tools，自建通过 contextSchema 运行时注入
 * - 迭代限制：prebuilt 不内置 maxIterations，自建通过 shouldContinue 控制
 *
 * 局限性（本项目场景）：
 * - model 和 tools 在 compile 时固定，不支持 contextSchema 运行时动态切换
 * - 每次 provider/model 变化需要重新 compile，有微小性能开销
 * - 无内置 maxIterations 保护，需要外部通过 recursionLimit 控制
 *
 * @param model - LangChain Chat Model 实例（已由 AiModelFactory 创建）
 * @param tools - 工具列表（已由 ToolRegistry 提供）
 * @returns 编译后的 CompiledStateGraph 实例，可直接 invoke/stream
 */
export function buildPrebuiltReactAgent(
  model: BaseChatModel,
  tools: StructuredToolInterface[],
) {
  return createReactAgent({
    llm: model,
    tools,
  });
}

/**
 * Prebuilt ReAct Agent 编译产物类型
 */
export type PrebuiltReactAgentCompiled = ReturnType<
  typeof buildPrebuiltReactAgent
>;
