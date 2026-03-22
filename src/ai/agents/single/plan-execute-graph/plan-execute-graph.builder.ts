import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { GraphNode, BaseCheckpointSaver } from '@langchain/langgraph';
import { StateGraph, START, END } from '@langchain/langgraph';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import * as z from 'zod';

import type { PlanExecuteStateType, StepResult } from './plan-execute.state';
import { PlanExecuteState } from './plan-execute.state';
import {
  PLANNER_SYSTEM_PROMPT,
  REPLANNER_SYSTEM_PROMPT,
  buildExecutorPrompt,
} from './plan-execute.prompts';
import { buildToolGraph } from '../tool-graph';

/**
 * Plan-Execute 图的运行时上下文
 *
 * Planner 和 Replanner 使用同一模型（规划能力），
 * Executor 的 tool-graph 子图通过 executorModel + tools 独立注入。
 */
export interface PlanExecuteGraphContext {
  /** 规划模型（用于 Planner 和 Replanner） */
  plannerModel: BaseChatModel;
  /** 执行模型（用于 Executor 子图中的工具调用循环） */
  executorModel: BaseChatModel;
  /** Executor 可用工具列表 */
  tools: StructuredToolInterface[];
  /** Executor 子图的最大迭代次数 */
  maxIterations: number;
}

const PlanExecuteContextSchema = z.object({
  plannerModel: z.custom<BaseChatModel>(),
  executorModel: z.custom<BaseChatModel>(),
  tools: z.array(z.custom<StructuredToolInterface>()),
  maxIterations: z.number().default(5),
});

/**
 * Planner 和 Replanner 输出的结构化类型
 */
interface PlanResult {
  steps: string[];
}

interface ReplanDecision {
  action: 'complete' | 'continue' | 'replan';
  response?: string;
  steps?: string[];
}

// ============================================================
// 节点定义
// ============================================================

/**
 * planner 节点 — 将用户目标分解为步骤列表
 *
 * 通过 SystemMessage 注入规划提示词，要求模型返回结构化 JSON。
 * 解析后的步骤列表写入 state.plan。
 */
const plannerNode: GraphNode<PlanExecuteStateType> = async (state, config) => {
  const ctx = config?.context as PlanExecuteGraphContext | undefined;
  if (!ctx?.plannerModel) {
    throw new Error(
      'plannerNode 缺少 context.plannerModel，请通过 contextSchema 注入',
    );
  }

  // 提取最后一条 HumanMessage
  const userMessages = state.messages.filter((m) => m.type === 'human');
  // 提取原始目标，最后一条 HumanMessage 的 content
  const objective = serializeMessageContent(
    userMessages[userMessages.length - 1]?.content ?? '',
  );

  const messages = [
    new SystemMessage(PLANNER_SYSTEM_PROMPT),
    new HumanMessage(objective),
  ];

  const response = await ctx.plannerModel.invoke(messages);
  const responseText =
    typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);

  const planResult = parsePlanResult(responseText);

  return {
    plan: planResult.steps,
    currentStepIndex: 0,
  };
};

/**
 * executor 节点 — 执行当前步骤
 *
 * 核心 Subgraph 组合点：
 * 将 tool-graph 编译为子图，在 executor 节点内部 invoke。
 * 子图拥有独立的 AgentState（messages + toolCallCount + iterationCount），
 * executor 负责父子状态转换：
 *
 * 父 → 子：将当前步骤描述 + 上下文构建为 HumanMessage 注入子图
 * 子 → 父：从子图输出提取最终 AIMessage 作为步骤结果
 *
 * 这种"在节点内调用子图"的模式适用于父子图状态 Schema 不同的场景。
 */
const executorNode: GraphNode<PlanExecuteStateType> = async (state, config) => {
  const ctx = config?.context as PlanExecuteGraphContext | undefined;
  if (!ctx?.executorModel || !ctx?.tools) {
    throw new Error('executorNode 缺少 context.executorModel 或 context.tools');
  }

  // 获取当前步骤
  const currentStep = state.plan[state.currentStepIndex];
  // 如果当前步骤为空，则返回最终响应
  if (!currentStep) {
    return {
      finalResponse: '计划中没有更多步骤可执行',
    };
  }

  // 提取原始目标
  const userMessages = state.messages.filter((m) => m.type === 'human');
  const originalObjective = serializeMessageContent(
    userMessages[userMessages.length - 1]?.content ?? '',
  );

  // 构建执行提示
  const executorPrompt = buildExecutorPrompt(
    currentStep,
    state.pastStepResults,
    originalObjective,
  );

  // Subgraph 组合：编译 tool-graph 子图并 invoke
  // 子图使用独立的 AgentState（messages + toolCallCount + iterationCount）
  const subgraph = buildToolGraph();

  // 构建子图输入
  const subgraphInput = {
    messages: [
      new SystemMessage(executorPrompt),
      new HumanMessage(currentStep),
    ],
  };

  // 调用子图
  const subgraphResult = await subgraph.invoke(subgraphInput, {
    context: {
      model: ctx.executorModel,
      tools: ctx.tools,
      maxIterations: ctx.maxIterations,
    },
  });

  // 子 → 父：提取子图最终 AIMessage 的内容作为步骤结果
  const lastMessage =
    subgraphResult.messages[subgraphResult.messages.length - 1];
  const stepResult =
    typeof lastMessage.content === 'string'
      ? lastMessage.content
      : JSON.stringify(lastMessage.content);

  const result: StepResult = {
    step: currentStep,
    result: stepResult,
  };

  return {
    pastStepResults: result,
    currentStepIndex: state.currentStepIndex + 1,
  };
};

/**
 * 复核规划者节点
 * replanner 节点 — 审视执行进度，决定下一步行动
 *
 * 三种决策：
 * 1. complete — 任务完成，生成最终响应
 * 2. continue — 继续执行当前计划的下一步
 * 3. replan — 调整剩余步骤
 */
const replannerNode: GraphNode<PlanExecuteStateType> = async (
  state,
  config,
) => {
  const ctx = config?.context as PlanExecuteGraphContext | undefined;
  if (!ctx?.plannerModel) {
    throw new Error(
      'replannerNode 缺少 context.plannerModel，请通过 contextSchema 注入',
    );
  }

  // 提取原始目标
  const userMessages = state.messages.filter((m) => m._getType() === 'human');
  const originalObjective = serializeMessageContent(
    userMessages[userMessages.length - 1]?.content ?? '',
  );

  // 构建 Replanner 输入
  const completedSteps = state.pastStepResults
    .map(({ step, result }) => `- **${step}**: ${result.slice(0, 300)}`)
    .join('\n');

  const remainingSteps = state.plan
    .slice(state.currentStepIndex)
    .map((s, i) => `${state.currentStepIndex + i + 1}. ${s}`)
    .join('\n');

  const replannerInput = `## Original Objective
${originalObjective}

## Completed Steps
${completedSteps || '(none yet)'}

## Remaining Plan
${remainingSteps || '(all steps completed)'}

Based on the completed results, decide what to do next.`;

  const messages = [
    new SystemMessage(REPLANNER_SYSTEM_PROMPT),
    new HumanMessage(replannerInput),
  ];

  const response = await ctx.plannerModel.invoke(messages);
  const responseText =
    typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);

  const decision = parseReplanDecision(responseText);

  switch (decision.action) {
    case 'complete':
      return {
        finalResponse: decision.response ?? '任务已完成',
        messages: [
          new AIMessage({
            content: decision.response ?? '任务已完成',
          }),
        ],
      };

    case 'replan':
      if (decision.steps?.length) {
        return {
          plan: [
            ...state.plan.slice(0, state.currentStepIndex),
            ...decision.steps,
          ],
        };
      }
      return {};

    case 'continue':
    default:
      return {};
  }
};

/**
 * shouldContinueExecution — 条件路由
 *
 * 路由逻辑：
 * 1. finalResponse 非空 → END（任务完成）
 * 2. 还有未执行的步骤 → executor（继续执行）
 * 3. 所有步骤已执行完 → END（即使 replanner 没有显式标记完成）
 */
function shouldContinueExecution(state: {
  plan: string[];
  currentStepIndex: number;
  finalResponse?: string;
}): 'executor' | typeof END {
  if (state.finalResponse) {
    return END;
  }

  if (state.currentStepIndex < state.plan.length) {
    return 'executor';
  }

  return END;
}

// ============================================================
// 图构建器
// ============================================================

/** Plan-Execute 图编译产物类型 */
export type PlanExecuteGraphCompiled = ReturnType<typeof buildPlanExecuteGraph>;

/**
 * 构建 Plan-and-Execute 图
 *
 * 拓扑结构：
 * ```
 * START → planner → executor → replanner → shouldContinueExecution
 *                      ↑                         │
 *                      └── currentStep < plan ───┘
 *                                                │
 *                      finalResponse ────────────→ END
 * ```
 *
 * Subgraph 组合：
 * executor 节点内部调用 tool-graph 子图来执行每个步骤，
 * 子图拥有独立的 AgentState，通过 executor 节点做父子状态转换。
 *
 * @param options - 可选的 checkpointer（用于持久化执行）
 * @returns 编译后的 Plan-Execute 状态图
 */
export function buildPlanExecuteGraph(options?: {
  checkpointer?: BaseCheckpointSaver;
}) {
  const graph = new StateGraph(PlanExecuteState, PlanExecuteContextSchema)
    // 注册 planner 节点
    .addNode('planner', plannerNode)
    // 注册 executor 节点
    .addNode('executor', executorNode)
    // 注册 replanner 节点
    .addNode('replanner', replannerNode)
    // 创建一条 无条件边：图启动后，第一个执行 planner 节点
    .addEdge(START, 'planner')
    // 创建一条 无条件边：planner 节点执行完后，执行 executor 节点
    .addEdge('planner', 'executor')
    // 创建一条 无条件边：executor 节点执行完后，执行 replanner 节点
    .addEdge('executor', 'replanner')
    // 创建一条 条件边：replanner 节点执行完后，根据 shouldContinueExecution 的返回值，决定走向 executor 节点还是 END 节点
    .addConditionalEdges('replanner', shouldContinueExecution, {
      executor: 'executor',
      [END]: END,
    });

  return graph.compile({
    checkpointer: options?.checkpointer,
  });
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 解析 Planner 的 JSON 输出为步骤列表
 */
function parsePlanResult(responseText: string): PlanResult {
  try {
    let cleaned = responseText.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { steps: [responseText.trim()] };
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<PlanResult>;

    if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
      return { steps: parsed.steps.map(String) };
    }

    return { steps: [responseText.trim()] };
  } catch {
    // 降级：将整段文本作为单步骤
    return { steps: [responseText.trim()] };
  }
}

/**
 * 解析 Replanner 的 JSON 决策
 */
function parseReplanDecision(responseText: string): ReplanDecision {
  try {
    let cleaned = responseText.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // 无法解析时默认视为任务完成
      return { action: 'complete', response: responseText };
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<ReplanDecision>;

    if (parsed.action === 'complete') {
      return {
        action: 'complete',
        response: parsed.response ?? responseText,
      };
    }

    if (parsed.action === 'replan' && Array.isArray(parsed.steps)) {
      return {
        action: 'replan',
        steps: parsed.steps.map(String),
      };
    }

    if (parsed.action === 'continue') {
      return { action: 'continue' };
    }

    return { action: 'complete', response: responseText };
  } catch {
    return { action: 'complete', response: responseText };
  }
}

/**
 * 将 LangChain message content 序列化为稳定字符串，避免对象走默认的
 * `[object Object]` 字符串化结果污染提示词内容。
 */
function serializeMessageContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}
