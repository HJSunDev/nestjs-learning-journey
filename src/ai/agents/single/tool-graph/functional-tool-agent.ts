import { entrypoint, task } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { BaseMessage } from '@langchain/core/messages';
import {
  AIMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';

/**
 * Functional API 版工具调用 Agent
 *
 * 用 entrypoint + task 过程式范式实现与 Graph API 等价的工具调用循环。
 * 两种 API 共享同一套持久化/中断机制，选择取决于场景偏好：
 *
 * - Graph API（tool-graph.builder.ts）：声明式，适合需要可视化的复杂拓扑
 * - Functional API（本文件）：过程式，适合线性逻辑，代码更直观
 *
 * task() 的持久化语义：
 * - 当配合 checkpointer 使用时，已完成的 task 在恢复执行时不会重复运行
 * - 要求 task 内的操作具有幂等性
 * - 为 049 章的 durable execution 做铺垫
 */

/**
 * callModel task — 调用 LLM（绑定工具后）
 *
 * task() 将这个副作用操作包装为可持久化的执行单元。
 * 持久化恢复时，如果此 task 已完成，直接返回缓存结果而不重新调用 LLM。
 */
const callModelTask = task(
  'callModel',
  async (params: {
    model: BaseChatModel;
    tools: StructuredToolInterface[];
    messages: BaseMessage[];
  }): Promise<AIMessage> => {
    const { model, tools, messages } = params;

    const modelToInvoke =
      tools.length > 0 && typeof model.bindTools === 'function'
        ? model.bindTools(tools)
        : model;

    const response = await modelToInvoke.invoke(messages);

    return new AIMessage({
      content:
        typeof response.content === 'string'
          ? response.content
          : JSON.stringify(response.content),
      tool_calls: response.tool_calls,
      response_metadata: response.response_metadata,
      usage_metadata: response.usage_metadata,
    });
  },
);

/**
 * executeTools task — 执行工具调用
 *
 * 逐个执行 AIMessage 中的 tool_calls，返回 ToolMessage 数组。
 * 工具执行失败时将错误信息作为 ToolMessage 返回给模型。
 */
const executeToolsTask = task(
  'executeTools',
  async (params: {
    aiMessage: AIMessage;
    tools: StructuredToolInterface[];
  }): Promise<ToolMessage[]> => {
    const { aiMessage, tools } = params;
    const toolMap = new Map(tools.map((t) => [t.name, t]));
    const results: ToolMessage[] = [];

    for (const toolCall of aiMessage.tool_calls ?? []) {
      const tool = toolMap.get(toolCall.name);
      const callId =
        toolCall.id ??
        `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      if (!tool) {
        results.push(
          new ToolMessage({
            content: `工具 "${toolCall.name}" 不存在`,
            tool_call_id: callId,
          }),
        );
        continue;
      }

      try {
        const result: unknown = await tool.invoke(
          toolCall.args as Record<string, unknown>,
        );
        results.push(
          new ToolMessage({
            content:
              typeof result === 'string' ? result : JSON.stringify(result),
            tool_call_id: callId,
          }),
        );
      } catch (error) {
        results.push(
          new ToolMessage({
            content: `工具 "${toolCall.name}" 执行出错: ${error instanceof Error ? error.message : String(error)}`,
            tool_call_id: callId,
          }),
        );
      }
    }

    return results;
  },
);

/**
 * 构建 Functional API 工具调用 Agent
 *
 * 使用 entrypoint 定义工作流入口，内部通过 while 循环和 task 实现
 * 与 Graph API 版本等价的 callModel → shouldContinue → executeTools 循环。
 *
 * 关键差异：
 * - Graph API 的循环由显式的条件边驱动（声明式）
 * - Functional API 的循环由 while 语句驱动（过程式）
 * - 两者在持久化/中断/streaming 层面行为一致
 */
export function buildFunctionalToolAgent() {
  return entrypoint(
    { name: 'functionalToolAgent' },
    async (input: {
      messages: BaseMessage[];
      model: BaseChatModel;
      tools: StructuredToolInterface[];
      systemPrompt?: string;
      maxIterations?: number;
    }): Promise<{
      messages: BaseMessage[];
      content: string;
      totalIterations: number;
      toolCallCount: number;
    }> => {
      const { model, tools, systemPrompt, maxIterations = 5 } = input;
      let currentMessages: BaseMessage[] = [...input.messages];

      if (systemPrompt) {
        currentMessages = [new SystemMessage(systemPrompt), ...currentMessages];
      }

      let totalIterations = 0;
      let toolCallCount = 0;

      for (let i = 0; i < maxIterations; i++) {
        totalIterations++;

        const aiMessage = await callModelTask({
          model,
          tools,
          messages: currentMessages,
        });

        currentMessages.push(aiMessage);

        if (!aiMessage.tool_calls?.length) {
          return {
            messages: currentMessages,
            content:
              typeof aiMessage.content === 'string'
                ? aiMessage.content
                : JSON.stringify(aiMessage.content),
            totalIterations,
            toolCallCount,
          };
        }

        const toolMessages = await executeToolsTask({
          aiMessage,
          tools,
        });

        currentMessages.push(...toolMessages);
        toolCallCount += aiMessage.tool_calls.length;
      }

      // 达到最大迭代限制，做最终不带工具的调用
      const finalResponse = await callModelTask({
        model,
        tools: [],
        messages: currentMessages,
      });

      currentMessages.push(finalResponse);

      return {
        messages: currentMessages,
        content:
          typeof finalResponse.content === 'string'
            ? finalResponse.content
            : JSON.stringify(finalResponse.content),
        totalIterations: totalIterations + 1,
        toolCallCount,
      };
    },
  );
}

/**
 * 编译后的 Functional Agent 类型
 */
export type FunctionalToolAgent = ReturnType<typeof buildFunctionalToolAgent>;
