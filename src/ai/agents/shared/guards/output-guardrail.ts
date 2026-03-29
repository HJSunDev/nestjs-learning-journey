import { Logger } from '@nestjs/common';
import type { GuardrailResult } from './input-guardrail';

const logger = new Logger('OutputGuardrail');

/**
 * 输出守卫检查结果（扩展 GuardrailResult，携带清洗后的内容）
 */
export interface OutputGuardrailResult extends GuardrailResult {
  /** 清洗后的内容（仅在 passed=true 且有脱敏处理时与原文不同） */
  sanitizedContent?: string;
  /** 触发的规则列表 */
  triggeredRules: string[];
}

/**
 * 常见 PII（个人可识别信息）模式
 *
 * 检测 Agent 输出中可能包含的敏感个人信息。
 * 即使 Agent 的训练数据或工具返回结果中无意包含了 PII，
 * 输出守卫也能在返回给用户前进行脱敏处理。
 */
const PII_PATTERNS: Array<{ name: string; pattern: RegExp; mask: string }> = [
  {
    name: 'phone_cn',
    pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
    mask: '***手机号***',
  },
  {
    name: 'id_card_cn',
    pattern: /(?<!\d)\d{17}[\dXx](?!\d)/g,
    mask: '***身份证号***',
  },
  {
    name: 'email',
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    mask: '***邮箱***',
  },
  {
    name: 'bank_card',
    pattern: /(?<!\d)\d{16,19}(?!\d)/g,
    mask: '***银行卡号***',
  },
  {
    name: 'ipv4',
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    mask: '***IP地址***',
  },
];

/**
 * 内容安全关键词（Agent 不应输出的有害内容模式）
 *
 * 检测 Agent 输出中的不安全内容，包括：
 * - 泄露系统提示词
 * - 执行危险操作的指令
 * - 明显的幻觉标记
 */
const SAFETY_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'system_prompt_leak',
    pattern:
      /(?:my\s+(?:system\s+)?(?:prompt|instructions?)\s+(?:is|are|says?))/i,
  },
  {
    name: 'dangerous_command',
    pattern:
      /(?:rm\s+-rf\s+\/|DROP\s+(?:TABLE|DATABASE)|FORMAT\s+[A-Z]:|del\s+\/[sfq]\s)/i,
  },
  {
    name: 'jailbreak_compliance',
    pattern:
      /(?:as\s+(?:an?\s+)?(?:evil|unfiltered|unrestricted)\s+(?:AI|assistant|model))/i,
  },
];

/**
 * 验证并清洗 Agent 输出
 *
 * 执行多层检查：
 * 1. 内容安全检测（不安全内容直接拦截）
 * 2. PII 脱敏（敏感信息替换为掩码）
 *
 * 与输入守卫（validateInput）形成双向防护：
 * - 输入守卫：防止恶意输入（Prompt Injection 等）→ 不通过则拒绝请求
 * - 输出守卫：防止有害输出（PII 泄露、系统提示词泄露等）→ 不通过则拦截或脱敏
 *
 * @param content - Agent 输出的文本内容
 * @param options - 配置选项
 * @returns 守卫检查结果（包含是否通过、清洗后的内容和触发规则）
 *
 * @example
 * // 参数示例
 * const content = '用户的手机号是13800138000';
 *
 * // 调用示例
 * const result = validateOutput(content);
 *
 * // 返回值示例
 * // { passed: true, sanitizedContent: '用户的手机号是***手机号***', triggeredRules: ['pii:phone_cn'] }
 */
export function validateOutput(
  content: string,
  options: {
    /** 是否启用 PII 脱敏（默认 true） */
    enablePiiSanitization?: boolean;
    /** 是否启用内容安全检测（默认 true） */
    enableSafetyCheck?: boolean;
  } = {},
): OutputGuardrailResult {
  const { enablePiiSanitization = true, enableSafetyCheck = true } = options;

  const triggeredRules: string[] = [];

  // 第一层：内容安全检测（硬拦截）
  if (enableSafetyCheck) {
    for (const { name, pattern } of SAFETY_PATTERNS) {
      if (pattern.test(content)) {
        logger.warn(`输出安全检测触发: ${name} — "${content.slice(0, 80)}..."`);
        triggeredRules.push(`safety:${name}`);
        return {
          passed: false,
          reason: `输出内容触发安全规则: ${name}`,
          triggeredRules,
        };
      }
    }
  }

  // 第二层：PII 脱敏（软处理，替换后放行）
  let sanitized = content;
  if (enablePiiSanitization) {
    for (const { name, pattern, mask } of PII_PATTERNS) {
      // 重置全局正则状态
      pattern.lastIndex = 0;
      if (pattern.test(sanitized)) {
        pattern.lastIndex = 0;
        sanitized = sanitized.replace(pattern, mask);
        triggeredRules.push(`pii:${name}`);
        logger.debug(`PII 脱敏: ${name}`);
      }
    }
  }

  return {
    passed: true,
    sanitizedContent: sanitized !== content ? sanitized : undefined,
    triggeredRules,
  };
}
