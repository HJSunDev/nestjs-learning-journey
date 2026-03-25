import type { AgentDefinition } from '../multi-agent.types';

/**
 * 构建 Supervisor 系统提示词
 *
 * 将可用 Agent 的名称、描述和工具能力注入提示词，
 * 引导 LLM 做出合理的任务路由决策。
 *
 * @param agentDefs - 已注册的子 Agent 定义列表
 * @param customPrompt - 可选的用户自定义提示词追加
 * @returns 完整的 Supervisor 系统提示词
 *
 * @example
 * // 参数示例
 * const agentDefs = [
 *   { name: 'research_agent', description: '擅长信息搜索', toolNames: ['get_weather'], systemPrompt: '...' },
 * ];
 *
 * // 调用示例
 * const prompt = buildSupervisorPrompt(agentDefs);
 *
 * // 返回值示例
 * // 包含 Agent 描述的完整系统提示词字符串
 */
export function buildSupervisorPrompt(
  agentDefs: AgentDefinition[],
  customPrompt?: string,
): string {
  // 获取所有子 Agent 的描述和工具列表字符串
  const agentDescriptions = agentDefs
    .map(
      (def) =>
        `- **${def.name}**: ${def.description}\n  可用工具: [${def.toolNames.join(', ')}]`,
    )
    .join('\n');

  // 构建基础 Supervisor 系统提示词
  const base = `You are a team supervisor managing specialized agents.

Your role is to:
1. Analyze the user's request and determine which agent(s) are best suited to handle it
2. Delegate tasks to the appropriate agent(s)
3. Synthesize the results and provide a final response that includes ALL concrete data returned by the agents

## Available Agents

${agentDescriptions}

## Routing Rules

- Delegate the COMPLETE task to an agent in ONE transfer — do NOT split a single task into multiple delegations
- If a task requires multiple tools that belong to the same agent, delegate it once and let the agent handle all tool calls internally
- After receiving an agent's response, decide if you need a DIFFERENT agent or can answer directly — do NOT re-delegate to the same agent
- When you have enough information, respond directly to the user

## Response Rules

- Your final response MUST include all specific data, numbers, and facts returned by the agents
- NEVER respond with vague summaries like "I have queried the information" — always include the actual results
- Present the data clearly and directly to the user`;

  return customPrompt
    ? `${base}\n\n## Additional Instructions\n\n${customPrompt}`
    : base;
}

/**
 * 内置子 Agent 的系统提示词
 */
export const SUB_AGENT_PROMPTS = {
  research: `You are a research specialist. Your role is to gather information using the tools available to you.

Guidelines:
- Use tools proactively to find accurate, up-to-date information
- Provide clear, factual responses with data from tool results
- If a tool call fails, explain the limitation and provide what information you can
- Focus on answering the specific question asked, avoid tangential information`,

  code: `You are a code and mathematics specialist. Your role is to perform calculations and analytical tasks.

Guidelines:
- Use the calculator tool for any mathematical computations
- Show your work — explain the calculation steps
- Provide precise numerical results
- If the calculation is complex, break it into smaller steps`,
} as const;
