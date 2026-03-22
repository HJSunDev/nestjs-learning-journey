/**
 * 规划制订者
 * Plan-and-Execute 模式的提示词模板
 *
 * 生产级设计：
 * - Planner 使用结构化输出约束返回 JSON 格式的步骤列表
 * - Executor 将当前步骤和上下文组合为清晰的执行指令
 * - Replanner 基于已完成步骤的结果决定后续行动
 */

/**
 * Planner 系统提示词 — 将用户目标分解为可执行步骤
 *
 * 引导模型产出结构化的步骤列表。
 * 要求每个步骤是原子化的、可独立执行的、有明确完成标准的。
 */
export const PLANNER_SYSTEM_PROMPT = `You are a planning expert. Your job is to break down a complex objective into a clear, ordered list of actionable steps.

## Rules
1. Each step must be atomic — it should accomplish exactly ONE thing
2. Steps should be ordered by dependency (prerequisite steps first)
3. Each step must be self-contained and actionable
4. Keep the plan concise — typically 3-6 steps for most tasks
5. If the task is simple enough to answer directly, create a single step

## Output Format
You MUST respond with ONLY a valid JSON object (no markdown fences, no extra text):

{"steps": ["step 1 description", "step 2 description", ...]}

Example:
User: "Research the benefits of TypeScript and write a summary report"
Output: {"steps": ["Search for the main benefits of TypeScript over JavaScript", "Identify at least 5 key advantages with supporting evidence", "Write a structured summary report covering all identified benefits"]}`;

/**
 * 构建 Executor 的执行指令
 *
 * 将当前步骤、已完成的上下文整合为一条清晰的执行提示。
 * Executor 可以使用工具来完成步骤。
 *
 * @param currentStep - 当前要执行的步骤描述
 * @param pastResults - 之前步骤的执行结果（提供上下文）
 * @param originalObjective - 用户的原始目标（保持方向一致性）
 */
export function buildExecutorPrompt(
  currentStep: string,
  pastResults: Array<{ step: string; result: string }>,
  originalObjective: string,
): string {
  let prompt = `You are an execution agent. Complete the following step as part of a larger plan.

## Original Objective
${originalObjective}

## Current Step
${currentStep}
`;

  if (pastResults.length > 0) {
    prompt += '\n## Previous Results (for context)\n';
    for (const { step, result } of pastResults) {
      prompt += `- **${step}**: ${result.slice(0, 500)}\n`;
    }
  }

  prompt += `
## Instructions
1. Focus ONLY on completing the current step
2. Use available tools if needed
3. Provide a clear, concise result for this step
4. Do not attempt to complete future steps`;

  return prompt;
}

/**
 * 规划评估者
 * Replanner 系统提示词 — 审视进度并决定下一步行动
 *
 * 基于已完成步骤的结果，Replanner 有三种决策：
 * 1. 任务已完成 → 生成最终响应
 * 2. 原计划仍然有效 → 继续执行下一步
 * 3. 需要调整计划 → 生成新的剩余步骤列表
 */
export const REPLANNER_SYSTEM_PROMPT = `You are a plan evaluator. Given the original objective and the results of completed steps, decide what to do next.

## Decision Options

### Option 1: Task is COMPLETE
If all necessary information has been gathered and the objective can be fully answered:
{"action": "complete", "response": "Your comprehensive final answer here..."}

### Option 2: Continue with current plan
If the next planned step is still relevant and should proceed:
{"action": "continue"}

### Option 3: Replan remaining steps
If the remaining steps need adjustment based on what was learned:
{"action": "replan", "steps": ["new step 1", "new step 2", ...]}

## Rules
1. You MUST respond with ONLY a valid JSON object (no markdown fences)
2. Choose "complete" when you have enough information to provide a thorough answer
3. Choose "replan" only when intermediate results reveal that remaining steps are wrong or insufficient
4. The final response should be comprehensive, synthesizing ALL step results`;
