import type { StructuredToolInterface } from '@langchain/core/tools';
import type { ToolCall } from '@langchain/core/messages/tool';
import type { GraphNode } from '@langchain/langgraph';
import { AIMessage, ToolMessage } from '@langchain/core/messages';

import type { AgentStateType } from '../states/agent.state';
import type { ToolGraphContext } from './call-model.node';

/**
 * executeTools 节点 — 执行模型请求的工具调用
 *
 * 职责：
 * 1. 从 messages 末尾的 AIMessage 中提取 tool_calls
 * 2. 根据 toolCallStrategy 选择执行策略（parallel / sequential）
 * 3. 将每个工具结果封装为 ToolMessage 追加到 messages
 * 4. 累加 toolCallCount
 *
 * 执行策略：
 * - parallel（默认）：适用于独立工具调用（如同时查两个城市天气），
 *   使用 Promise.allSettled 并行执行，部分失败不影响其他工具
 * - sequential：适用于有状态/有序操作（如浏览器自动化：移动鼠标→点击→输入文字），
 *   按模型输出顺序逐个执行，前一个失败时后续不再执行
 *
 * 错误处理：
 * 工具执行失败不终止图的运行，而是将错误信息作为 ToolMessage 返回给模型，
 * 让模型自行决定是否重试或换用其他工具。
 */
export const executeToolsNode: GraphNode<AgentStateType> = async (
  state,
  config,
) => {
  // 获取运行时上下文
  const ctx = config?.context as ToolGraphContext | undefined;
  if (!ctx?.tools) {
    throw new Error(
      'executeToolsNode 缺少运行时 context.tools，请通过 contextSchema 注入',
    );
  }

  // 获取状态中的最后一项消息
  const lastMessage = state.messages[state.messages.length - 1];

  // 如果最后一项消息不是 AIMessage 或者没有 tool_calls，则返回空消息
  if (!(lastMessage instanceof AIMessage) || !lastMessage.tool_calls?.length) {
    return { messages: [], toolCallCount: 0 };
  }

  // 创建工具映射
  const toolMap = new Map<string, StructuredToolInterface>(
    ctx.tools.map((t) => [t.name, t]),
  );
  // 获取可用工具名称,示例："getWeather,calculate,getCurrentTime"
  const availableToolNames = ctx.tools.map((t) => t.name).join(', ');
  // 获取工具调用策略
  const strategy =
    ctx.toolCallStrategy === 'sequential' ? 'sequential' : 'parallel';

  const toolMessages =
    strategy === 'sequential' // 如果工具调用策略为 sequential，则按顺序逐个执行工具调用
      ? await executeSequentially(
          lastMessage.tool_calls,
          toolMap,
          availableToolNames,
        ) // 如果工具调用策略为 parallel，则并行执行工具调用
      : await executeInParallel(
          lastMessage.tool_calls,
          toolMap,
          availableToolNames,
        );

  return {
    messages: toolMessages,
    toolCallCount: lastMessage.tool_calls.length,
  };
};

/**
 * 并行执行所有工具调用
 *
 * 使用 Promise.allSettled：即使部分工具失败，仍收集全部结果返回给模型。
 * 适用场景：工具之间无依赖关系（如同时查天气 + 做计算）。
 */
async function executeInParallel(
  toolCalls: ToolCall[],
  toolMap: Map<string, StructuredToolInterface>,
  availableToolNames: string,
): Promise<ToolMessage[]> {
  // 并行执行所有工具调用，返回一个包含所有工具调用结果的数组,allSettled会等待所有工具调用完成，无论成功还是失败
  const settled = await Promise.allSettled(
    toolCalls.map((tc) => invokeSingleTool(tc, toolMap, availableToolNames)),
  );

  return settled.map((r) =>
    r.status === 'fulfilled'
      ? r.value.message
      : new ToolMessage({
          content: `工具执行异常: ${String(r.reason)}`,
          tool_call_id: `tc_${Date.now()}`,
          name: 'unknown',
        }),
  );
}

/**
 * 按顺序逐个执行工具调用
 *
 * 前一个工具失败时，后续工具不再执行，直接标记为"因前序失败而跳过"。
 * 适用场景：有状态操作（浏览器自动化、表单填写、有序 API 调用）。
 */
async function executeSequentially(
  toolCalls: ToolCall[],
  toolMap: Map<string, StructuredToolInterface>,
  availableToolNames: string,
): Promise<ToolMessage[]> {
  const results: ToolMessage[] = [];
  let aborted = false;

  for (const toolCall of toolCalls) {
    const callId =
      toolCall.id ??
      `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (aborted) {
      results.push(
        new ToolMessage({
          content: `工具 "${toolCall.name}" 未执行：前序工具调用失败，后续操作已中止`,
          tool_call_id: callId,
          name: toolCall.name,
        }),
      );
      continue;
    }

    const { message, failed } = await invokeSingleTool(
      toolCall,
      toolMap,
      availableToolNames,
    );
    results.push(message);

    if (failed) {
      aborted = true;
    }
  }

  return results;
}

interface ToolInvokeResult {
  message: ToolMessage;
  /** sequential 模式下用于判断是否中止后续调用 */
  failed: boolean;
}

/**
 * 执行单个工具调用，统一错误处理
 *
 * 无论成功还是失败，始终返回 ToolMessage（不抛异常），
 * 让模型在下一轮推理中看到完整的执行结果。
 */
async function invokeSingleTool(
  toolCall: ToolCall,
  toolMap: Map<string, StructuredToolInterface>,
  availableToolNames: string,
): Promise<ToolInvokeResult> {
  const tool = toolMap.get(toolCall.name);
  const fallbackId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const callId = toolCall.id ?? fallbackId;

  if (!tool) {
    return {
      message: new ToolMessage({
        content: `工具 "${toolCall.name}" 不存在，可用工具: ${availableToolNames}`,
        tool_call_id: callId,
        name: toolCall.name,
      }),
      failed: true,
    };
  }

  try {
    const result: unknown = await tool.invoke(
      toolCall.args as Record<string, unknown>,
    );
    return {
      message: new ToolMessage({
        content: typeof result === 'string' ? result : JSON.stringify(result),
        tool_call_id: callId,
        name: toolCall.name,
      }),
      failed: false,
    };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      message: new ToolMessage({
        content: `工具 "${toolCall.name}" 执行出错: ${errMsg}`,
        tool_call_id: callId,
        name: toolCall.name,
      }),
      failed: true,
    };
  }
}
