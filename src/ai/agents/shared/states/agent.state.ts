import { StateSchema, MessagesValue, ReducedValue } from '@langchain/langgraph';
import * as z from 'zod';

/**
 * Agent 共享状态定义 - 图的 共享数据载体
 * reducer: 归约函数，用于合并状态更新
 *
 * 使用 LangGraph v1 推荐的 StateSchema + Zod v4 方式定义。
 *
 * 三种 Value 类型：
 * - MessagesValue：内置消息 reducer，自动追加新消息，支持 RemoveMessage 等修饰符
 * - ReducedValue：自定义 reducer，解决并行节点写入冲突（如累加器）
 * - 普通 Zod 字段：Last-Write-Wins 语义，后写入的值覆盖前值
 *
 * 此 State 服务于工具调用图（047）和后续 ReAct Agent（048）。
 */
export const AgentState = new StateSchema({
  /**
   * 对话消息列表（含 Human/AI/Tool 消息）
   *
   * MessagesValue 内置 reducer， 自动将新消息 追加 到列表末尾，
   * 支持通过 RemoveMessage 实例从列表中移除指定消息。
   */
  messages: MessagesValue,

  /**
   * 工具调用总次数（跨轮次累加器）- 自定义 reducer
   *
   * ReducedValue 确保并行节点同时写入时不会丢失更新。
   * 用于监控 Agent 效率，超过阈值时可触发熔断。
   */
  toolCallCount: new ReducedValue(z.number().default(0), {
    reducer: (current: number, update: number) => current + update,
  }),

  /**
   * 当前迭代轮次（Last-Write-Wins）- 普通 Zod 字段
   *
   * 由 callModel 节点在每次调用前自增，用于判断是否达到最大迭代限制。
   */
  iterationCount: z.number().default(0),
});

/**
 * Agent 状态的 TypeScript 类型
 *
 * 从 StateSchema 推断，供 GraphNode<typeof AgentState> 使用。
 */
export type AgentStateType = typeof AgentState;
