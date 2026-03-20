import { StateGraph, START, END } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import * as z from 'zod';

import { AgentState } from '../../shared/states/agent.state';
import { callModelNode } from '../../shared/nodes/call-model.node';
import { executeToolsNode } from '../../shared/nodes/execute-tools.node';
import { shouldContinue, ROUTE } from '../../shared/nodes/should-continue';

/**
 * contextSchema — 运行时注入的类型约束
 *
 * 定义了从 NestJS DI 层传入 LangGraph 图的运行时参数。
 * compile 后通过 invoke/stream 的 { context: {...} } 传入。
 *
 * 这是 NestJS 与 LangGraph 协作的关键桥梁：
 * - NestJS 负责依赖注入（ConfigService → AiModelFactory → model 实例）
 * - LangGraph 通过 contextSchema 在图运行时接收这些实例
 * - 避免在 State 中存放非序列化对象（model 实例、工具实例等）
 */
const ContextSchema = z.object({
  model:
    z.custom<
      import('@langchain/core/language_models/chat_models').BaseChatModel
    >(),
  tools: z.array(
    z.custom<import('@langchain/core/tools').StructuredToolInterface>(),
  ),
  maxIterations: z.number().default(5),
});

/**
 * 构建工具调用状态图
 *
 * 专门为"工具调用场景"构建的图，不是通用图，图结构是写死的
 *
 * 这个图解决什么场景：
 * 用户提问 → AI 思考 → 调用工具 → AI 再思考 → ... → 最终回复
 *
 * 用 Graph API 实现与 043 ToolCallingLoop 等价的工具调用循环：
 *
 * ```
 * ┌─────────┐      ┌────────────────┐      ┌──────────────┐
 * │  START  │────▶│  callModel     │────▶│shouldContinue│
 * └─────────┘      └────────────────┘      └──────┬───────┘
 *                        ▲                        │
 *                        │              ┌─────────┴─────────┐
 *                        │              │                   │
 *                        │         has tool_calls      no tool_calls
 *                        │              │                   │
 *                        │              ▼                   ▼
 *                        │     ┌──────────────┐       ┌─────────┐
 *                        └─────│ executeTools │       │   END   │
 *                              └──────────────┘       └─────────┘
 * ```
 *
 * vs 043 ToolCallingLoop（黑盒 while 循环）的关键差异：
 * - 每个节点是独立的、可观测的执行单元
 * - 条件路由是显式声明的，而非隐藏在 if/else 中
 * - 图级别的 streaming events 可精确到节点粒度
 * - 传入 checkpointer 后，每个 super-step 边界自动保存 checkpoint（049 Durable Execution）
 *
 * @param options - 可选的编译选项
 * @param options.checkpointer - BaseCheckpointSaver 实例（PostgresSaver / MemorySaver），
 *   传入后图具备断点续传、Time-travel、状态回溯能力
 * @returns 编译后的 CompiledStateGraph 实例
 */
export function buildToolGraph(options?: {
  checkpointer?: BaseCheckpointSaver;
}) {
  // 创建一个 StateGraph 实例，使用 AgentState 作为状态模式，使用 ContextSchema 作为运行时配置
  const graph = new StateGraph(AgentState, ContextSchema)
    // 注册 callModel 节点
    .addNode('callModel', callModelNode)
    // 注册 executeTools 节点
    .addNode('executeTools', executeToolsNode)
    // 创建一条 无条件边：图启动后，第一个执行 callModel节点
    .addEdge(START, 'callModel')
    // 创建一条 条件边：callModel 节点执行完后，根据 shouldContinue 的返回值，决定走向 executeTools 节点还是 END 节点
    .addConditionalEdges('callModel', shouldContinue, {
      // 如果 shouldContinue 返回 ROUTE.TOOLS，则走向 executeTools 节点
      [ROUTE.TOOLS]: 'executeTools',
      // 如果 shouldContinue 返回 ROUTE.END，则走向 END 节点
      [ROUTE.END]: END,
    })
    // 创建一条 无条件边：executeTools 节点执行完后，回到 callModel 节点
    .addEdge('executeTools', 'callModel');

  // 编译图，传入 checkpointer 时启用持久化（每个 super-step 边界自动保存 checkpoint）
  return graph.compile({
    checkpointer: options?.checkpointer,
  });
}

/**
 * 编译后的图类型导出
 *
 * 供 GraphService 做类型约束使用。
 */
export type ToolGraphCompiled = ReturnType<typeof buildToolGraph>;
