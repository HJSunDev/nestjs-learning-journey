import { StateSchema, MessagesValue } from '@langchain/langgraph';
import * as z from 'zod';

/**
 * Reflection 自我修正图的状态定义
 *
 * 与基础 AgentState 不同，Reflection 模式不需要工具调用追踪，
 * 而是需要追踪反思轮次和评估结果来驱动"生成 → 评估 → 修正"循环。
 *
 * 消息流：
 * 1. 用户消息（原始任务）
 * 2. AI 生成内容（generator 输出）
 * 3. AI 评估反馈（evaluator 输出，作为 HumanMessage 注入供 generator 参考）
 * 4. AI 修正内容（generator 基于评估反馈重新生成）
 * ... 循环直到评估通过或达到最大反思次数
 */
export const ReflectionState = new StateSchema({
  /** 对话消息列表（生成内容和评估反馈交替追加） */
  messages: MessagesValue,

  /** 当前反思轮次（由 evaluateNode 自增） */
  reflectionCount: z.number().default(0),

  /** 最大反思次数（超过后强制结束，防止无限循环） */
  maxReflections: z.number().default(3),

  /**
   * 评估是否通过
   *
   * - undefined：尚未评估（初始状态）
   * - true：评估通过，路由到 END
   * - false：评估未通过，路由回 generate 节点进行修正
   */
  evaluationPassed: z.boolean().optional(),

  /** 评估者最近一次反馈（供日志和结果提取用） */
  lastFeedback: z.string().optional(),

  /** 评估分数 0-10（供监控和日志用） */
  lastScore: z.number().optional(),
});

export type ReflectionStateType = typeof ReflectionState;
