import { interrupt, Command } from '@langchain/langgraph';
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';

import type { ToolGraphContext } from '../../shared/nodes/call-model.node';
import {
  ReviewAction,
  type HitlConfig,
  type HitlResumeValue,
  type ReviewDecision,
  type ToolCallDecision,
  type InterruptValue,
} from '../../hitl/hitl.types';

/**
 * HITL 图运行时上下文扩展
 *
 * 在 ToolGraphContext 基础上增加 hitlConfig 配置，
 * 控制审批行为（是否启用、哪些工具免审批）。
 */
export interface HitlGraphContext extends ToolGraphContext {
  hitlConfig?: HitlConfig;
}

/**
 * reviewToolCalls 节点 — 人机协同审批的核心中断点
 *
 * 在 callModel → shouldContinue 判定"需要调用工具"之后、executeTools 之前执行。
 * 通过 LangGraph 的 interrupt() 函数暂停图执行，将待执行的工具调用列表
 * 呈现给外部审批人，等待 Command({ resume }) 恢复。
 *
 * 支持两种审批粒度（对齐 Claude Agent SDK / OpenAI Agents SDK 生产标准）：
 *
 * 批量模式（ReviewDecision）：
 * - approve:               Command({ goto: 'executeTools' }) → 按原样执行
 * - approve + updatedInput: Command({ goto: 'executeTools', update }) → 用修改后的参数执行
 * - reject:                Command({ goto: 'callModel', update }) → ToolMessage 反馈
 *
 * 逐工具模式（ToolCallDecision[]）：
 * - 全部 approve → executeTools
 * - 全部 reject  → callModel + 反馈
 * - 混合决策     → callModel + 逐工具复合反馈（协议合规，模型可据此重试已批准工具）
 *
 * 幂等性说明：
 * interrupt() 恢复时，整个节点从头重新执行。此节点在 interrupt() 之前没有副作用，
 * 符合 LangGraph 对 interrupt 节点的幂等性要求。
 *
 * @param state - 当前代理状态
 * @param config - 运行时配置（含 HitlGraphContext）
 * @returns Command 动态路由指令
 */
export const reviewToolCallsNode = (
  state: { messages: BaseMessage[] },
  config?: LangGraphRunnableConfig,
) => {
  const ctx = config?.context as HitlGraphContext | undefined;
  const hitlConfig = ctx?.hitlConfig;

  const lastMessage = state.messages[state.messages.length - 1];

  // 如果最后一项消息不是 AIMessage 或者没有 tool_calls，则直接放行
  if (!AIMessage.isInstance(lastMessage) || !lastMessage.tool_calls?.length) {
    return new Command({ goto: 'executeTools' });
  }

  if (!hitlConfig?.enabled) {
    return new Command({ goto: 'executeTools' });
  }

  // 获取免审批工具列表（白名单）
  const autoApproveTools = hitlConfig.autoApproveTools ?? [];

  // 如果所有工具调用均在免审批列表中，则直接放行
  const allAutoApproved = lastMessage.tool_calls.every((tc) =>
    autoApproveTools.includes(tc.name),
  );
  if (allAutoApproved) {
    return new Command({ goto: 'executeTools' });
  }

  // 只提取需要审批的工具调用（排除白名单）
  const toolCallsNeedingReview = lastMessage.tool_calls
    .filter((tc) => !autoApproveTools.includes(tc.name))
    .map((tc) => ({
      id: tc.id ?? `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: tc.name,
      arguments: tc.args as Record<string, unknown>,
    }));

  // 构建中断载荷，呈现给审批人
  const interruptPayload: InterruptValue = {
    type: 'tool_call_review',
    toolCalls: toolCallsNeedingReview,
    message: `Agent 请求调用 ${lastMessage.tool_calls.length} 个工具，其中 ${toolCallsNeedingReview.length} 个需要审批。`,
  };

  // === 中断点 ===
  // 暂停图执行，将 interruptPayload 呈现给外部审批人，等待 Command({ resume }) 恢复。
  //
  // resumeValue 数据结构（HitlResumeValue = ReviewDecision | ToolCallDecision[]）：
  //
  // 批量模式 — ReviewDecision:
  //   { action: 'approve' | 'reject',
  //     reason?: string,                          // reject 时的驳回原因
  //     updatedInput?: EditedToolCall[] }          // approve 时可选替换工具参数
  //
  // 逐工具模式 — ToolCallDecision[]:
  //   [{ toolCallId: string,                      // 对应 interruptPayload.toolCalls[].id
  //      action: 'approve' | 'reject',
  //      reason?: string,                         // reject 时的驳回原因
  //      updatedArgs?: Record<string, unknown> }]  // approve 时可选替换参数
  //
  // 通过 'action' in resumeValue 区分两种模式（数组无 'action' 属性）
  const resumeValue: HitlResumeValue = interrupt(interruptPayload);

  // ===== 恢复后的路由逻辑 =====

  // 入口已确保 lastMessage 是 AIMessage 且 tool_calls 非空
  const toolCalls = lastMessage.tool_calls ?? [];

  // 如果 resumeValue 是 批量模式，路由到批量模式
  if (!Array.isArray(resumeValue) && 'action' in resumeValue) {
    return routeBatchDecision(resumeValue, lastMessage, toolCalls);
  }

  // 如果 resumeValue 是 逐工具模式，则路由到逐工具模式
  return routePerToolDecisions(
    resumeValue,
    lastMessage,
    toolCalls,
    autoApproveTools,
  );
};

// ============================================================
// 批量模式路由
// ============================================================

/**
 * 批量模式 — 同一决策应用于所有待审批工具
 */
function routeBatchDecision(
  decision: ReviewDecision,
  lastMessage: AIMessage,
  toolCalls: NonNullable<AIMessage['tool_calls']>,
) {
  // 如果 decision.action 是 批准 approve
  if (decision.action === ReviewAction.APPROVE) {
    // 如果用户提供了反馈内容 decision.updatedInput 有值，则替换工具参数
    if (decision.updatedInput?.length) {
      // 构建新的 AIMessage 替换原始AIMessage的 toolCalls
      // 因为 executeTools 节点会 读取最后一条 AIMessage 的 tool_calls，并逐个执行，所以要构建新的 AIMessage
      // id 必须与原始 AIMessage 一致，addMessages reducer 据此替换而非追加
      const editedAiMessage = new AIMessage({
        id: lastMessage.id,
        content:
          typeof lastMessage.content === 'string'
            ? lastMessage.content
            : JSON.stringify(lastMessage.content),
        tool_calls: decision.updatedInput.map((etc) => ({
          id: etc.id,
          name: etc.name,
          args: etc.args,
          type: 'tool_call' as const,
        })),
        additional_kwargs: lastMessage.additional_kwargs,
        response_metadata: lastMessage.response_metadata,
      });

      return new Command({
        goto: 'executeTools',
        update: { messages: [editedAiMessage] },
      });
    }
    // 没有提供反馈内容，直接放行
    return new Command({ goto: 'executeTools' });
  }

  // 如果 decision.action 是 驳回 reject，则生成 ToolMessage 反馈
  const feedbackReason = decision.reason || '审批人未提供具体原因';
  // 为每个工具调用生成 ToolMessage 反馈
  const feedbackMessages = toolCalls.map(
    (tc) =>
      new ToolMessage({
        content:
          `工具调用被审批人驳回。原因: ${feedbackReason}。` +
          '请根据反馈重新思考是否需要调用此工具，或尝试其他方式回答用户的问题。',
        tool_call_id:
          tc.id ?? `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: tc.name ?? 'unknown',
      }),
  );

  return new Command({
    goto: 'callModel',
    update: { messages: feedbackMessages },
  });
}

// ============================================================
// 逐工具模式路由
// ============================================================

/**
 * 逐工具模式 — 每个工具调用有独立的 approve/reject 决策
 *
 * 三种情况的路由策略：
 *
 * 1. 全部 approve（批准） → executeTools（有 updatedArgs 时替换参数）
 * 2. 全部 reject（驳回） → callModel + 逐工具拒绝反馈
 * 3. 混合决策     → callModel + 复合反馈（协议合规：每个 tool_call 都有 ToolMessage）
 *
 * 混合决策的设计考量：
 * 不采用"只执行已批准工具"的方案，因为会产生与 tool_call_id 不匹配的孤立
 * ToolMessage，违反 LLM 提供商的消息协议约束。
 * 改为将所有 tool_call 的审批结果以 ToolMessage 反馈给模型，
 * 模型在下一轮推理中自然只重试已批准的工具。
 */
function routePerToolDecisions(
  decisions: ToolCallDecision[],
  lastMessage: AIMessage,
  toolCalls: NonNullable<AIMessage['tool_calls']>,
  autoApproveTools: string[],
) {
  // toolCallId → decision 的快速查找表，后续遍历 toolCalls 时 O(1) 匹配决策
  const decisionMap = new Map(decisions.map((d) => [d.toolCallId, d]));

  // 按审批动作分组，用于后续三路分支：全部批准 / 全部驳回 / 混合决策
  const approved = decisions.filter((d) => d.action === ReviewAction.APPROVE);
  const rejected = decisions.filter((d) => d.action === ReviewAction.REJECT);

  // ── 分支 1: 全部 approve ──
  // 无驳回 → 直接执行工具，有参数修改时替换后再执行
  if (rejected.length === 0) {
    // 检查是否有审批人修改过的参数需要合并
    const hasUpdates = approved.some((d) => d.updatedArgs);
    if (hasUpdates) {
      // 遍历原始 toolCalls，逐个检查是否有 updatedArgs 需要替换
      const mergedToolCalls = toolCalls.map((tc) => {
        const perToolDecision = decisionMap.get(tc.id ?? '');
        // 审批人提供了修改参数 → 用 updatedArgs 替换原始 args
        if (perToolDecision?.updatedArgs) {
          return {
            id: tc.id ?? '',
            name: tc.name,
            args: perToolDecision.updatedArgs,
            type: 'tool_call' as const,
          };
        }
        return {
          id: tc.id ?? '',
          name: tc.name,
          args: tc.args,
          type: 'tool_call' as const,
        };
      });

      // 构建新的 AIMessage 替换原始AIMessage的 toolCalls
      // 因为 executeTools 节点会 读取最后一条 AIMessage 的 tool_calls，并逐个执行，所以要构建新的 AIMessage
      // id 必须与原始 AIMessage 一致，addMessages reducer 据此替换而非追加
      const editedAiMessage = new AIMessage({
        id: lastMessage.id,
        content:
          typeof lastMessage.content === 'string'
            ? lastMessage.content
            : JSON.stringify(lastMessage.content),
        tool_calls: mergedToolCalls,
        additional_kwargs: lastMessage.additional_kwargs,
        response_metadata: lastMessage.response_metadata,
      });

      return new Command({
        goto: 'executeTools',
        update: { messages: [editedAiMessage] },
      });
    }

    return new Command({ goto: 'executeTools' });
  }

  // ── 分支 2 & 3: 有驳回 → 全部回退到 callModel ──
  // 构建 ToolMessage 反馈给模型，只要有驳回，就需要回退到 callModel节点
  // 不能只执行已批准的工具，因为 LLM 协议要求每个 tool_call 都有对应 ToolMessage
  const feedbackMessages = toolCalls.map((tc) => {
    const tcId =
      tc.id ?? `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // 用 tcId 查找审批人对这个工具的决策（白名单工具不在 decisionMap 中）
    const perToolDecision = decisionMap.get(tcId);

    // 白名单工具：decisionMap 没记录，但在 autoApproveTools 中 → 未经人工审批
    if (!perToolDecision && autoApproveTools.includes(tc.name)) {
      // 混合决策：虽然白名单自动通过，但整批回退所以也不执行
      if (approved.length > 0) {
        return new ToolMessage({
          content:
            '此工具已通过自动审批（白名单），但因部分工具被驳回，' +
            '本轮未执行。请在下一次调用中重新请求此工具。',
          tool_call_id: tcId,
          name: tc.name ?? 'unknown',
        });
      }
      // 全部驳回：白名单工具也跟着不执行
      return new ToolMessage({
        content: '因全部工具调用被驳回，本轮未执行。',
        tool_call_id: tcId,
        name: tc.name ?? 'unknown',
      });
    }

    // 人工批准但混合决策：被其他工具的驳回连坐，本轮不执行
    if (perToolDecision?.action === ReviewAction.APPROVE) {
      return new ToolMessage({
        content:
          '此工具调用已通过人工审批，但因其他工具被驳回，本轮未执行。' +
          '请在下一次调用中重新请求此工具。',
        tool_call_id: tcId,
        name: tc.name ?? 'unknown',
      });
    }

    // 人工驳回：将驳回原因反馈给模型
    const reason = perToolDecision?.reason || '审批人未提供具体原因';
    return new ToolMessage({
      content:
        `工具调用被审批人驳回。原因: ${reason}。` +
        '请根据反馈重新思考是否需要调用此工具，或尝试其他方式回答用户的问题。',
      tool_call_id: tcId,
      name: tc.name ?? 'unknown',
    });
  });

  return new Command({
    goto: 'callModel',
    update: { messages: feedbackMessages },
  });
}
