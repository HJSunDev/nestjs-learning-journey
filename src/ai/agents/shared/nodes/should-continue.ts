import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';

/**
 * 图的路由目标常量
 *
 * 与 addConditionalEdges 的路由映射配合使用，
 * 避免硬编码字符串导致的拼写错误。
 */
export const ROUTE = {
  TOOLS: 'executeTools',
  END: '__end__',
} as const;

/**
 * shouldContinue — 条件边路由函数 - 决定图执行完 callModel 后往哪走
 *
 * 在 callModel 节点之后执行，决定图的下一步走向：
 *
 * 1. 模型响应包含 tool_calls 且未达到最大迭代 → 路由到 executeTools 节点
 * 2. 模型响应不含 tool_calls（最终文本回复）→ 路由到 END
 * 3. 达到最大迭代限制 → 路由到 END（防止无限循环）
 *
 * 这个函数替代了 043 ToolCallingLoop 中的 while 循环判断条件，
 * 将隐式的循环控制转变为显式的、可观测的条件路由。
 */
export function shouldContinue(
  state: {
    messages: BaseMessage[];
    iterationCount: number;
    toolCallCount: number;
  },
  config?: LangGraphRunnableConfig,
): typeof ROUTE.TOOLS | typeof ROUTE.END {
  // 获取 messages 列表的最后一项，即最新的一条消息
  const lastMessage = state.messages[state.messages.length - 1];
  // 获取运行时配置
  const ctx = config?.context as { maxIterations?: number } | undefined;
  // 获取最大迭代次数，如果没有配置，则默认5次，“??” 是空值合并运算符，如果左边为空，则返回右边
  const maxIterations = ctx?.maxIterations ?? 5;

  // 如果当前迭代轮次大于等于最大迭代次数，则路由到 END
  if (state.iterationCount >= maxIterations) {
    return ROUTE.END;
  }
  // 如果最后一项是 AIMessage 且有 tool_calls，则路由到 TOOLS
  if (lastMessage instanceof AIMessage && lastMessage.tool_calls?.length) {
    return ROUTE.TOOLS;
  }

  // 否则路由到 END
  return ROUTE.END;
}
