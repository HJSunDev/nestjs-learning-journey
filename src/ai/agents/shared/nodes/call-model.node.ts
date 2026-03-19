import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { GraphNode } from '@langchain/langgraph';
import { AIMessage } from '@langchain/core/messages';

import type { AgentStateType } from '../states/agent.state';

/**
 * 运行时上下文类型
 *
 * 通过 contextSchema 从 NestJS DI 层注入到 LangGraph 图的运行时配置。
 * 每次 invoke/stream 调用时由 GraphService 动态传入。
 */
export interface ToolGraphContext {
  /** LangChain Chat Model 实例（由 AiModelFactory 创建） */
  model: BaseChatModel;
  /** 可用工具列表（由 ToolRegistry 提供） */
  tools: StructuredToolInterface[];
  /** 最大迭代次数 */
  maxIterations: number;
  /**
   * 工具调用执行策略
   *
   * - 'parallel'（默认）：所有 tool_calls 并行执行，适用于独立工具（查天气 + 算数学）
   * - 'sequential'：按模型输出顺序逐个执行，适用于有状态操作（浏览器自动化、表单填写、有序 API 调用）
   */
  toolCallStrategy?: 'parallel' | 'sequential';
}

/**
 * callModel 节点 — 调用 LLM 并返回 AIMessage
 * call-model.node.ts 做一件事：调用模型，返回 AI 的回复。
 *
 * 职责：
 * 1. 从 config.context 拿到 model 和 tools
 * 2. 将 tools 绑定到 model（model.bindTools）
 * 3. 调用 model.invoke(messages)
 * 4. 返回 AIMessage + 更新 iterationCount
 *
 * 这是一个纯函数：读取 State + context → 返回 State 更新。
 * 不修改传入的 State，符合 LangGraph 的不可变状态设计。
 *
 * @param state - 当前的代理状态，包含历史消息记录 (messages) 和当前迭代次数 (iterationCount)
 * @param config - LangGraph 运行时配置，其中 `config.context` 包含了注入的运行上下文 (`ToolGraphContext`)
 * @returns 包含状态更新的 Partial 对象（Partial 表示只需返回发生变更的部分状态字段即可，无需返回完整的 state，LangGraph 底层的 reducer 会自动将这些局部变更与现有状态合并。这里返回了新的 `messages` 数组和自增的 `iterationCount`）
 */
export const callModelNode: GraphNode<AgentStateType> = async (
  state,
  config,
) => {
  const ctx = config?.context as ToolGraphContext | undefined;
  if (!ctx?.model) {
    throw new Error(
      'callModelNode 缺少运行时 context.model，请通过 contextSchema 注入',
    );
  }

  const { model, tools } = ctx;

  // 如果工具列表不为空，则为模型绑定工具
  // 否则直接使用模型实例
  const modelToInvoke =
    tools.length > 0 && typeof model.bindTools === 'function'
      ? model.bindTools(tools)
      : model;

  const response = await modelToInvoke.invoke(state.messages);

  // 确保返回标准 AIMessage 以兼容 MessagesValue reducer
  const aiMessage = new AIMessage({
    content:
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content),
    tool_calls: response.tool_calls,
    additional_kwargs: response.additional_kwargs,
    response_metadata: response.response_metadata,
    usage_metadata: response.usage_metadata,
  });

  return {
    messages: [aiMessage],
    // 自增 当前迭代轮次, 用于判断是否达到最大迭代限制
    iterationCount: state.iterationCount + 1,
  };
};
