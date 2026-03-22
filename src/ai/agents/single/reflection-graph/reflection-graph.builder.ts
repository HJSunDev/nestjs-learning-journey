import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { GraphNode, BaseCheckpointSaver } from '@langchain/langgraph';
import { StateGraph, START, END } from '@langchain/langgraph';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import * as z from 'zod';

import type { ReflectionStateType } from './reflection.state';
import { ReflectionState } from './reflection.state';
import {
  DEFAULT_GENERATOR_PROMPT,
  buildEvaluatorPrompt,
} from './reflection.prompts';

/**
 * Reflection 图的运行时上下文
 *
 * 通过 contextSchema 注入，包含 Generator 和 Evaluator 的模型实例及配置。
 * 支持为 Generator 和 Evaluator 使用不同的模型（如 Evaluator 用更强的模型做质量把关）。
 */
export interface ReflectionGraphContext {
  /** Generator 模型（生成内容） */
  generatorModel: BaseChatModel;
  /** Evaluator 模型（评估质量，可与 generator 相同也可使用更强的模型） */
  evaluatorModel: BaseChatModel;
  /** Generator 系统提示词（空字符串时使用默认提示词） */
  generatorPrompt: string;
  /** 评估标准（空字符串时使用默认标准） */
  evaluationCriteria: string;
}

const ReflectionContextSchema = z.object({
  generatorModel: z.custom<BaseChatModel>(),
  evaluatorModel: z.custom<BaseChatModel>(),
  generatorPrompt: z.string().default(''),
  evaluationCriteria: z.string().default(''),
});

/**
 * 评估结果的 JSON 结构
 */
interface EvaluationResult {
  passed: boolean;
  score: number;
  feedback: string;
}

// ============================================================
// 节点定义
// ============================================================

/**
 * 生产节点
 * generate 节点 — 调用 Generator 模型生成或修正内容
 *
 * 首次调用：基于用户任务描述生成初始内容
 * 后续调用：基于 Evaluator 的反馈修正内容
 *
 * 将 generatorPrompt 作为 SystemMessage 注入，
 * 保持 messages 中的历史完整传递给模型。
 */
const generateNode: GraphNode<ReflectionStateType> = async (state, config) => {
  const ctx = config?.context as ReflectionGraphContext | undefined;
  if (!ctx?.generatorModel) {
    throw new Error(
      'generateNode 缺少 context.generatorModel，请通过 contextSchema 注入',
    );
  }

  // 获取系统提示词
  const systemPrompt = ctx.generatorPrompt || DEFAULT_GENERATOR_PROMPT;

  // 构建消息列表
  const messagesForModel = [new SystemMessage(systemPrompt), ...state.messages];

  // 获取 生产者模型 的结果
  const response = await ctx.generatorModel.invoke(messagesForModel);

  // 构建 AIMessage 消息对象
  const aiMessage = new AIMessage({
    content:
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content),
    response_metadata: response.response_metadata,
    usage_metadata: response.usage_metadata,
  });

  return { messages: [aiMessage] };
};

/**
 * 评估节点
 * evaluate 节点 — 调用 Evaluator 模型评估生成内容的质量
 *
 * 从 messages 中提取最后一条 AIMessage（Generator 的输出），
 * 连同原始任务要求一起发送给 Evaluator 模型。
 *
 * Evaluator 返回结构化 JSON：{ passed, score, feedback }
 * 评估结果写入 State 供 shouldReflect 条件路由使用。
 *
 * 若评估未通过，将 feedback 作为 HumanMessage 追加到 messages，
 * 供下一轮 generate 节点作为修正依据。
 */
const evaluateNode: GraphNode<ReflectionStateType> = async (state, config) => {
  const ctx = config?.context as ReflectionGraphContext | undefined;
  if (!ctx?.evaluatorModel) {
    throw new Error(
      'evaluateNode 缺少 context.evaluatorModel，请通过 contextSchema 注入',
    );
  }

  // 获取评估员系统提示词
  const evaluatorPrompt = buildEvaluatorPrompt(
    ctx.evaluationCriteria || undefined,
  );

  // 提取原始任务（第一条 HumanMessage）
  const originalTask =
    state.messages.find((m) => m.type === 'human')?.content ?? '';
  const lastAiMessage = [...state.messages]
    .reverse()
    .find((m) => m.type === 'ai');
  // 提取最新生成内容（最后一条 AIMessage的content）
  const generatedContent = lastAiMessage?.content ?? '';

  // 构建评估消息列表
  const evaluationMessages = [
    new SystemMessage(evaluatorPrompt),
    new HumanMessage(
      `## Original Task\n${serializePromptContent(originalTask)}\n\n## Content to Evaluate\n${serializePromptContent(generatedContent)}`,
    ),
  ];

  const response = await ctx.evaluatorModel.invoke(evaluationMessages);
  const responseText =
    typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);

  // 解析评估结果 JSON
  const evaluation = parseEvaluationResult(responseText);

  // 若评估未通过，将反馈作为 HumanMessage 注入 messages 供 generator 参考
  const feedbackMessages = evaluation.passed
    ? []
    : [
        new HumanMessage(
          `[Evaluator Feedback - Round ${state.reflectionCount + 1}]\n` +
            `Score: ${evaluation.score}/10\n` +
            `${evaluation.feedback}\n\n` +
            `Please revise your response to address ALL the issues above.`,
        ),
      ];

  return {
    messages: feedbackMessages,
    reflectionCount: state.reflectionCount + 1,
    evaluationPassed: evaluation.passed,
    lastFeedback: evaluation.feedback,
    lastScore: evaluation.score,
  };
};

/**
 * shouldReflect — 条件路由：决定是继续反思还是结束
 *
 * 路由逻辑：
 * 1. 评估通过 → END（质量达标）
 * 2. 已达最大反思次数 → END（防止无限循环，返回最后一版内容）
 * 3. 评估未通过且未达上限 → generate（带反馈修正）
 */
function shouldReflect(state: {
  reflectionCount: number;
  maxReflections: number;
  evaluationPassed?: boolean;
}): 'generate' | typeof END {
  // 如果评估通过，则路由到 END
  if (state.evaluationPassed) {
    return END;
  }

  // 如果已达最大反思次数，则路由到 END
  if (state.reflectionCount >= state.maxReflections) {
    return END;
  }

  // 否则路由到 generate 节点
  return 'generate';
}

// ============================================================
// 图构建器
// ============================================================

/** Reflection 图编译产物类型 */
export type ReflectionGraphCompiled = ReturnType<typeof buildReflectionGraph>;

/**
 * 构建 Reflection 自我修正图
 *
 * 拓扑结构：
 * ```
 * START → generate → evaluate → shouldReflect
 *                                  ├── evaluationPassed=true  → END
 *                                  ├── reflectionCount>=max   → END
 *                                  └── evaluationPassed=false → generate（带反馈修正）
 * ```
 *
 * @param options - 可选的 checkpointer（用于持久化执行）
 * @returns 编译后的 Reflection 状态图
 */
export function buildReflectionGraph(options?: {
  checkpointer?: BaseCheckpointSaver;
}) {
  const graph = new StateGraph(ReflectionState, ReflectionContextSchema)
    // 注册生产者节点
    .addNode('generate', generateNode)
    // 注册评估节点
    .addNode('evaluate', evaluateNode)
    // 创建一条 无条件边：图启动后，第一个执行 generate 节点
    .addEdge(START, 'generate')
    // 创建一条 无条件边：generate 节点执行完后，执行 evaluate 节点
    .addEdge('generate', 'evaluate')
    // 创建一条 条件边：evaluate 节点执行完后，根据 shouldReflect 的返回值，决定走向 generate 节点还是 END 节点
    .addConditionalEdges('evaluate', shouldReflect, {
      generate: 'generate',
      [END]: END,
    });

  // 编译图，传入 checkpointer 时启用持久化（每个 super-step 边界自动保存 checkpoint）
  return graph.compile({
    checkpointer: options?.checkpointer,
  });
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 解析 Evaluator 返回的 JSON 评估结果
 *
 * 对 LLM 输出做容错处理：
 * - 去除 markdown 代码围栏
 * - 提取 JSON 子串
 * - 字段缺失时使用安全默认值
 */
function parseEvaluationResult(responseText: string): EvaluationResult {
  try {
    // 去除 markdown 代码围栏
    let cleaned = responseText.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

    // 尝试提取 JSON 对象
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { passed: false, score: 0, feedback: responseText };
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<EvaluationResult>;

    return {
      passed: typeof parsed.passed === 'boolean' ? parsed.passed : false,
      score: typeof parsed.score === 'number' ? parsed.score : 0,
      feedback:
        typeof parsed.feedback === 'string' ? parsed.feedback : responseText,
    };
  } catch {
    // JSON 解析失败时视为未通过
    return {
      passed: false,
      score: 0,
      feedback: `评估结果解析失败，原始响应: ${responseText.slice(0, 200)}`,
    };
  }
}

/**
 * 将 LangChain message content 序列化为稳定字符串，避免对象走默认的
 * `[object Object]` 字符串化结果污染提示词内容。
 */
function serializePromptContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}
