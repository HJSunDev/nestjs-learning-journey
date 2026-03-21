import { StateGraph, START, END } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import * as z from 'zod';

import { AgentState } from '../../shared/states/agent.state';
import { callModelNode } from '../../shared/nodes/call-model.node';
import { executeToolsNode } from '../../shared/nodes/execute-tools.node';
import { shouldContinue, ROUTE } from '../../shared/nodes/should-continue';
import { reviewToolCallsNode } from './review-tools.node';

/**
 * HITL 上下文 Schema
 *
 * 在 047 ToolGraph 的 ContextSchema 基础上扩展 hitlConfig 字段，
 * 控制 reviewToolCalls 节点的审批行为。
 */
const HitlContextSchema = z.object({
  model:
    z.custom<
      import('@langchain/core/language_models/chat_models').BaseChatModel
    >(),
  tools: z.array(
    z.custom<import('@langchain/core/tools').StructuredToolInterface>(),
  ),
  maxIterations: z.number().default(5),
  hitlConfig: z
    .object({
      enabled: z.boolean().default(true),
      autoApproveTools: z.array(z.string()).default([]),
    })
    .optional(),
});

/**
 * 构建 HITL 工具调用状态图 — 带人类审批的 ReAct 图
 *
 * 在 047 buildToolGraph 的基础上，在 shouldContinue 判定"需要工具调用"后、
 * executeTools 之前，插入 reviewToolCalls 节点作为人类审批中断点。
 *
 * 图拓扑：
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
 *                        │     ┌──────────────────┐   ┌─────────┐
 *                        │     │reviewToolCalls   │   │   END   │
 *                        │     │ (interrupt 中断) │   └─────────┘
 *                        │     └───────┬──────────┘
 *                        │    approve/ │  reject
 *                        │    edit     │  (feedback → callModel)
 *                        │             ▼
 *                        │     ┌──────────────┐
 *                        └─────│ executeTools │
 *                              └──────────────┘
 * ```
 *
 * 与 047 buildToolGraph 的差异：
 * - 新增 reviewToolCalls 节点（使用 interrupt() 暂停等待人类输入）
 * - reviewToolCalls 通过 Command({ goto }) 动态路由到 executeTools 或 callModel
 * - checkpointer 是必需的（interrupt() 依赖持久化来保存暂停点状态）
 *
 * @param options - 编译选项
 * @param options.checkpointer - 持久化存储（必需，interrupt() 依赖）
 * @returns 编译后的 HITL 图实例
 */
export function buildHitlToolGraph(options: {
  checkpointer: BaseCheckpointSaver;
}) {
  const graph = new StateGraph(AgentState, HitlContextSchema)
    // 注册 callModel 节点
    .addNode('callModel', callModelNode)
    // 注册 reviewToolCalls 节点
    .addNode('reviewToolCalls', reviewToolCallsNode, {
      // ends 声明该节点可能路由到的所有目标节点
      ends: ['executeTools', 'callModel'],
    })
    // 注册 executeTools 节点
    .addNode('executeTools', executeToolsNode)
    // 创建一条 无条件边：图启动后，第一个执行 callModel节点
    .addEdge(START, 'callModel')
    // 创建一条 条件边：callModel 节点执行完后，根据 shouldContinue 的返回值，决定走向 executeTools 节点还是 END 节点
    .addConditionalEdges('callModel', shouldContinue, {
      [ROUTE.TOOLS]: 'reviewToolCalls',
      [ROUTE.END]: END,
    })
    // 创建一条 无条件边：executeTools 节点执行完后，回到 callModel 节点
    .addEdge('executeTools', 'callModel');

  return graph.compile({
    checkpointer: options.checkpointer,
  });
}

/**
 * HITL 图编译后的类型导出
 */
export type HitlGraphCompiled = ReturnType<typeof buildHitlToolGraph>;
