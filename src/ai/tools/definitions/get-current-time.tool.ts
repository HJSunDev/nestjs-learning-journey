import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

/**
 * 时间查询工具
 *
 * 当用户询问"现在几点"、"今天日期"、"某个时区的时间"时，
 * 模型会自主决定调用此工具获取实时时间信息。
 *
 * 此工具演示了最基础的 Tool Calling 模式：
 * - 无外部依赖，纯函数实现
 * - 使用 Zod 定义参数 Schema，LangChain 会将其转换为 JSON Schema 传给模型
 * - 模型通过 function calling 协议返回参数，LangChain 用 Zod 校验后传入 func
 */
export function createGetCurrentTimeTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'get_current_time',
    description:
      '获取当前的日期和时间。当用户询问时间、日期、星期几时使用此工具。' +
      '可以指定时区获取不同地区的时间。',
    schema: z.object({
      timezone: z
        .string()
        .optional()
        .describe(
          'IANA 时区标识符，如 "Asia/Shanghai"、"America/New_York"。' +
            '不传则使用服务器默认时区（Asia/Shanghai）。',
        ),
    }),
    func: ({ timezone }: { timezone?: string }) => {
      const tz = timezone || 'Asia/Shanghai';

      try {
        const now = new Date();
        const formatted = now.toLocaleString('zh-CN', {
          timeZone: tz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          weekday: 'long',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        });
        return Promise.resolve(`当前时间（${tz}）：${formatted}`);
      } catch {
        return Promise.resolve(
          `无法获取时区 "${tz}" 的时间，请使用有效的 IANA 时区标识符。`,
        );
      }
    },
  });
}
