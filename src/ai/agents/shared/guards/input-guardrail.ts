import { BadRequestException, Logger } from '@nestjs/common';

/**
 * 输入守卫检查结果
 */
export interface GuardrailResult {
  /** 是否通过检查 */
  passed: boolean;
  /** 被拒绝时的原因 */
  reason?: string;
}

/**
 * 已知的 Prompt Injection 关键词模式
 *
 * 检测常见的提示词注入攻击模式。
 * 仅做基础防护，生产环境应配合专业安全模型做深度检测。
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|above|prior)/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /system\s*:\s*/i,
  /\[SYSTEM\]/i,
  /forget\s+(everything|all|your)\s+(you|instructions?|rules?)/i,
  /override\s+(your|the|all)\s+(instructions?|rules?|restrictions?)/i,
];

/**
 * 单条消息的最大字符长度
 *
 * 超长消息可能是 Prompt Injection 或 DoS 攻击向量。
 */
const MAX_MESSAGE_LENGTH = 32_000;

/**
 * 单次请求的最大消息数量
 *
 * 防止通过大量消息耗尽上下文窗口或触发异常行为。
 */
const MAX_MESSAGE_COUNT = 100;

const logger = new Logger('InputGuardrail');

/**
 * 验证用户输入是否安全
 *
 * 执行多层检查：
 * 1. 消息数量限制
 * 2. 单条消息长度限制
 * 3. Prompt Injection 模式检测
 *
 * @param messages - 用户消息列表（role + content 结构）
 * @throws {BadRequestException} 当输入不安全时抛出，附带具体原因
 */
export function validateInput(
  messages: Array<{ role: string; content: string }>,
): void {
  if (messages.length > MAX_MESSAGE_COUNT) {
    throw new BadRequestException(
      `消息数量超限：最多 ${MAX_MESSAGE_COUNT} 条，收到 ${messages.length} 条`,
    );
  }

  for (const msg of messages) {
    if (msg.content.length > MAX_MESSAGE_LENGTH) {
      throw new BadRequestException(
        `消息内容过长：单条最多 ${MAX_MESSAGE_LENGTH} 字符，收到 ${msg.content.length} 字符`,
      );
    }

    // 仅对用户消息做注入检测
    if (msg.role === 'user') {
      const result = detectInjection(msg.content);
      if (!result.passed) {
        logger.warn(`Prompt Injection 检测触发: ${result.reason}`);
        throw new BadRequestException(`输入被安全策略拦截: ${result.reason}`);
      }
    }
  }
}

/**
 * 检测单条消息中的 Prompt Injection 模式
 *
 * @param content - 消息文本
 * @returns 检查结果，包含是否通过和拒绝原因
 */
function detectInjection(content: string): GuardrailResult {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(content)) {
      return {
        passed: false,
        reason: `检测到可疑指令模式: "${content.slice(0, 80)}..."`,
      };
    }
  }

  return { passed: true };
}
