import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

/**
 * 安全的数学表达式白名单
 *
 * 只允许数字、基本运算符、括号和空格，
 * 从输入层杜绝代码注入的可能性。
 */
const SAFE_MATH_PATTERN = /^[\d\s+\-*/().%]+$/;

/**
 * 数学计算工具
 *
 * 当用户需要精确的数学计算时，模型不应"心算"（容易出错），
 * 而是调用此工具获得精确结果。这是 Tool Calling 的经典应用场景：
 * 用外部工具弥补 LLM 在精确计算上的短板。
 *
 * 安全机制：
 * - 正则白名单过滤非法字符（防止代码注入）
 * - 异常捕获兜底
 */
export function createCalculateTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'calculate',
    description:
      '计算数学表达式并返回精确结果。支持加(+)、减(-)、乘(*)、除(/)、取模(%)、括号。' +
      '当用户需要精确数值计算时使用此工具，不要尝试心算。',
    schema: z.object({
      expression: z
        .string()
        .describe(
          '数学表达式，如 "(25 * 4) + 17.5"、"1024 / 8"、"(100 - 30) * 0.15"',
        ),
    }),
    func: ({ expression: rawExpr }) => {
      const expression = String(rawExpr);

      if (!SAFE_MATH_PATTERN.test(expression)) {
        return Promise.resolve(
          `计算失败：表达式 "${expression}" 包含非法字符。仅支持数字和 + - * / % ( ) 运算符。`,
        );
      }

      try {
        // Function 构造器在沙箱化的作用域中执行，比 eval 更可控
        // 安全性由上方正则白名单保证：输入仅含数字和运算符，不可能注入代码
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
        const result = new Function(
          `"use strict"; return (${expression})`,
        )() as number;

        if (!Number.isFinite(result)) {
          return Promise.resolve(
            `计算结果无效（${result}），请检查表达式是否存在除零等错误。`,
          );
        }

        return Promise.resolve(`${expression} = ${result}`);
      } catch {
        return Promise.resolve(
          `计算失败：无法解析表达式 "${expression}"，请检查语法是否正确。`,
        );
      }
    },
  });
}
