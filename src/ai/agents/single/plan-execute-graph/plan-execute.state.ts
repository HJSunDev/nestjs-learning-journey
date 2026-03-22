import { StateSchema, MessagesValue, ReducedValue } from '@langchain/langgraph';
import * as z from 'zod';

/**
 * 单个步骤的执行结果
 */
const StepResultSchema = z.object({
  /** 步骤描述 */
  step: z.string(),
  /** 执行结果 */
  result: z.string(),
});

export type StepResult = z.infer<typeof StepResultSchema>;

/**
 * Plan-and-Execute 图的状态定义
 *
 * 状态设计理念：
 * - plan：Planner 产出的步骤列表，Replanner 可覆盖更新
 * - pastStepResults：已完成步骤的结果累积（ReducedValue 防并发冲突）
 * - currentStepIndex：当前执行到的步骤索引（LWW）
 * - messages：保留对话上下文，用于构建最终响应
 * - finalResponse：Replanner 判定任务完成后生成的最终汇总
 */
export const PlanExecuteState = new StateSchema({
  /** 对话消息（用户原始输入 + 最终汇总响应） */
  messages: MessagesValue,

  /**
   * 任务计划步骤列表
   *
   * 由 Planner 初始生成，Replanner 可在执行过程中动态调整。
   * Last-Write-Wins：整体覆盖更新。
   */
  plan: z.array(z.string()).default([]),

  /** 当前执行步骤索引 */
  currentStepIndex: z.number().default(0),

  /**
   * 已完成步骤的执行结果（累积器）
   *
   * ReducedValue 确保并发场景下不丢失更新。
   * 每次 executor 完成一个步骤，追加一条 StepResult。
   */
  pastStepResults: new ReducedValue(z.array(StepResultSchema).default([]), {
    inputSchema: StepResultSchema,
    reducer: (current: StepResult[], update: StepResult) => [
      ...current,
      update,
    ],
  }),

  /**
   * 最终响应
   *
   * Replanner 判定所有步骤完成后生成的汇总回答。
   * 非空时触发路由到 respond → END。
   */
  finalResponse: z.string().optional(),
});

export type PlanExecuteStateType = typeof PlanExecuteState;
