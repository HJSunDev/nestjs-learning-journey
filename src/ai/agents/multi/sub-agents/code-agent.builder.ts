import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { createAgent } from 'langchain';
import type { AgentDefinition } from '../multi-agent.types';
import { SUB_AGENT_PROMPTS } from '../supervisor/supervisor.prompts';

/**
 * Code Agent 定义
 *
 * 代码与数学分析专家，配备计算工具。
 * 适用场景：需要数学计算或分析推理的任务。
 */
export const CODE_AGENT_DEF: AgentDefinition = {
  name: 'code_agent',
  description:
    'Code and mathematics specialist — can perform calculations, numerical analysis, and mathematical reasoning.',
  toolNames: ['calculate'],
  systemPrompt: SUB_AGENT_PROMPTS.code,
};

/**
 * 创建 Code Sub-Agent 编译图
 *
 * @param model - LLM 实例
 * @param tools - 此 Agent 可用的工具列表
 * @returns 编译后的 ReAct Agent
 *
 * @example
 * // 参数示例
 * const model = modelFactory.createChatModel('siliconflow', { model: 'xxx' });
 * const tools = toolRegistry.getTools(['calculate']);
 *
 * // 调用示例
 * const agent = buildCodeAgent(model, tools);
 *
 * // 返回值示例
 * // CompiledStateGraph，agent.name === 'code_agent'
 */
export function buildCodeAgent(
  model: BaseChatModel,
  tools: StructuredToolInterface[],
) {
  const agent = createAgent({
    model,
    tools,
    name: CODE_AGENT_DEF.name,
    systemPrompt: CODE_AGENT_DEF.systemPrompt,
  });

  return agent.graph;
}
