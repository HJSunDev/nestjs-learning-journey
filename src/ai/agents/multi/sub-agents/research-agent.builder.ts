import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { createAgent } from 'langchain';
import type { AgentDefinition } from '../multi-agent.types';
import { SUB_AGENT_PROMPTS } from '../supervisor/supervisor.prompts';

/**
 * Research Agent 定义
 *
 * 信息检索专家，配备天气查询和时间查询工具。
 * 适用场景：需要获取外部信息的查询任务。
 */
export const RESEARCH_AGENT_DEF: AgentDefinition = {
  name: 'research_agent',
  description:
    'Information research specialist — can look up weather, time, and other external data using tools.',
  toolNames: ['get_weather', 'get_current_time'],
  systemPrompt: SUB_AGENT_PROMPTS.research,
};

/**
 * 创建 Research Sub-Agent 编译图
 *
 * 使用 createReactAgent 创建带名称的 ReAct Agent，
 * 供 createSupervisor 作为子 Agent 使用。
 *
 * @param model - LLM 实例（由 AiModelFactory 创建）
 * @param tools - 此 Agent 可用的工具列表（已从 ToolRegistry 筛选）
 * @returns 编译后的 ReAct Agent（带 name 属性，Supervisor 据此生成 handoff 工具）
 *
 * @example
 * // 参数示例
 * const model = modelFactory.createChatModel('siliconflow', { model: 'xxx' });
 * const tools = toolRegistry.getTools(['get_weather', 'get_current_time']);
 *
 * // 调用示例
 * const agent = buildResearchAgent(model, tools);
 *
 * // 返回值示例
 * // CompiledStateGraph，agent.name === 'research_agent'
 */
export function buildResearchAgent(
  model: BaseChatModel,
  tools: StructuredToolInterface[],
) {
  const agent = createAgent({
    model,
    tools,
    name: RESEARCH_AGENT_DEF.name,
    systemPrompt: RESEARCH_AGENT_DEF.systemPrompt,
  });

  // createSupervisor 要求 CompiledStateGraph，通过 .graph 获取底层编译图
  return agent.graph;
}
