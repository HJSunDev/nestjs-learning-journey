import type { StructuredToolInterface } from '@langchain/core/tools';
import type { GraphNode } from '@langchain/langgraph';
import { AIMessage, ToolMessage } from '@langchain/core/messages';

import type { AgentStateType } from '../states/agent.state';
import type { ToolGraphContext } from './call-model.node';

/**
 * executeTools 节点 — 工具执行节点：执行模型请求的工具调用
 *
 * 职责：
 * 1. 从 messages 末尾的 AIMessage 中提取 tool_calls
 * 2. 逐个执行工具调用（通过 context.tools 查找工具实例）
 * 3. 将每个工具结果封装为 ToolMessage 追加到 messages
 * 4. 累加 toolCallCount
 *
 * AI 在 callModel 节点 已经决定了：
 * 1、要调用哪些工具
 * 2、每个工具传什么参数
 *
 * executeTools 节点只是 执行者，照着 AI 的决定去跑函数
 *
 * 错误处理：
 * 工具执行失败不终止图的运行，而是将错误信息作为 ToolMessage 返回给模型，
 * 把错误信息返回给模型，让模型自行决定是否重试或换用其他工具。这与 043 ToolCallingLoop 的策略一致。
 */
export const executeToolsNode: GraphNode<AgentStateType> = async (
  state,
  config,
) => {
  const ctx = config?.context as ToolGraphContext | undefined;
  if (!ctx?.tools) {
    throw new Error(
      'executeToolsNode 缺少运行时 context.tools，请通过 contextSchema 注入',
    );
  }

  // 获取 messages 列表的最后一项，即最新的一条消息，即模型返回的 AIMessage
  const lastMessage = state.messages[state.messages.length - 1];

  // 如果最后一项不是 AIMessage 或者没有 tool_calls，则返回空数组
  if (!(lastMessage instanceof AIMessage) || !lastMessage.tool_calls?.length) {
    return { messages: [], toolCallCount: 0 };
  }

  // 创建一个工具映射，将工具名称映射到工具实例
  const toolMap = new Map<string, StructuredToolInterface>(
    ctx.tools.map((t) => [t.name, t]),
  );

  // 创建一个工具消息数组，用于存储工具执行结果
  const toolMessages: ToolMessage[] = [];

  for (const toolCall of lastMessage.tool_calls) {
    // 获取工具实例
    const tool = toolMap.get(toolCall.name);
    // 生成工具调用 ID
    const callId =
      toolCall.id ??
      `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 如果工具实例不存在，则创建一个工具消息，表示工具不存在
    if (!tool) {
      toolMessages.push(
        new ToolMessage({
          content: `工具 "${toolCall.name}" 不存在，可用工具: ${ctx.tools.map((t) => t.name).join(', ')}`,
          tool_call_id: callId,
          name: toolCall.name,
        }),
      );
      continue;
    }

    try {
      // 执行工具调用
      const result: unknown = await tool.invoke(
        toolCall.args as Record<string, unknown>,
      );
      // 将工具执行结果封装为 ToolMessage 追加到 messages
      toolMessages.push(
        new ToolMessage({
          content: typeof result === 'string' ? result : JSON.stringify(result),
          tool_call_id: callId,
          name: toolCall.name,
        }),
      );
    } catch (error) {
      // 如果工具执行出错，则创建一个工具消息，表示工具执行出错
      const message = error instanceof Error ? error.message : String(error);
      // 将工具执行错误信息封装为 ToolMessage 追加到 messages
      toolMessages.push(
        new ToolMessage({
          content: `工具 "${toolCall.name}" 执行出错: ${message}`,
          tool_call_id: callId,
          name: toolCall.name,
        }),
      );
    }
  }

  // 返回工具执行结果和工具调用次数
  return {
    messages: toolMessages,
    toolCallCount: lastMessage.tool_calls.length,
  };
};
