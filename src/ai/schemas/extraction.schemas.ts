import { z } from 'zod';

/**
 * 结构化输出 Schema 定义
 *
 * 每个 Schema 用于约束 AI 模型的输出格式，通过 withStructuredOutput 绑定到模型后，
 * 模型将被强制返回符合 Schema 的 JSON 对象，而非自由文本。
 *
 * Zod 的 .describe() 会被转换为 JSON Schema 的 description 字段，
 * 直接作为指令传给模型，引导其填充正确的值。
 */

// ============================================================
// 情感分析 Schema
// ============================================================

export const SentimentAnalysisSchema = z.object({
  sentiment: z
    .enum(['positive', 'negative', 'neutral', 'mixed'])
    .describe('The overall sentiment of the text'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('Confidence score between 0 and 1'),
  keywords: z
    .array(z.string())
    .max(10)
    .describe('Key words or phrases that indicate the sentiment'),
  summary: z
    .string()
    .describe('A brief one-sentence summary of the sentiment analysis'),
});

/**
 * 类型推导：从 Zod Schema 自动生成 TypeScript 类型
 *
 * - z:           Zod 命名空间，提供 z.object()、z.string() 等构建器
 * - infer:       TypeScript 内置的条件类型关键字，用于"提取"类型
 * - z.infer<T>:  Zod 提供的工具类型，从 Zod Schema 递归推导出对应的 TS 类型
 *
 * 等价于手写：
 * type SentimentAnalysis = {
 *   sentiment: 'positive' | 'negative' | 'neutral' | 'mixed';
 *   confidence: number;
 *   keywords: string[];
 *   summary: string;
 * }
 *
 */
export type SentimentAnalysis = z.infer<typeof SentimentAnalysisSchema>;

// ============================================================
// 实体提取 Schema
// ============================================================

const PersonSchema = z.object({
  name: z.string().describe('Full name of the person'),
  role: z
    .string()
    .optional()
    .describe('Role or title of the person, if mentioned'),
});

export const EntityExtractionSchema = z.object({
  people: z
    .array(PersonSchema)
    .describe('List of people mentioned in the text'),
  organizations: z
    .array(z.string())
    .describe('List of organizations or companies mentioned'),
  locations: z
    .array(z.string())
    .describe('List of geographical locations mentioned'),
  dates: z
    .array(z.string())
    .describe('List of dates or time references mentioned'),
});

export type EntityExtraction = z.infer<typeof EntityExtractionSchema>;

// ============================================================
// 内容分类 Schema
// ============================================================

export const ContentClassificationSchema = z.object({
  category: z
    .enum([
      'technology',
      'business',
      'science',
      'health',
      'entertainment',
      'education',
      'politics',
      'other',
    ])
    .describe('The primary category of the content'),
  tags: z.array(z.string()).max(5).describe('Up to 5 relevant topic tags'),
  language: z
    .string()
    .describe('The language of the content (e.g. "zh-CN", "en")'),
  readingTimeMinutes: z
    .number()
    .min(1)
    .describe('Estimated reading time in minutes'),
});

export type ContentClassification = z.infer<typeof ContentClassificationSchema>;

// ============================================================
// 代码审查 Schema
// ============================================================

const CodeIssueSchema = z.object({
  line: z
    .number()
    .optional()
    .describe('Approximate line number where the issue occurs'),
  severity: z
    .enum(['critical', 'warning', 'suggestion'])
    .describe('Severity level of the issue'),
  description: z.string().describe('Brief description of the issue'),
  fix: z.string().optional().describe('Suggested fix for the issue'),
});

export const CodeReviewSchema = z.object({
  overallQuality: z
    .enum(['excellent', 'good', 'acceptable', 'needs_improvement', 'poor'])
    .describe('Overall code quality assessment'),
  issues: z
    .array(CodeIssueSchema)
    .describe('List of identified issues in the code'),
  strengths: z.array(z.string()).describe('Positive aspects of the code'),
  suggestions: z.array(z.string()).describe('General improvement suggestions'),
});

export type CodeReview = z.infer<typeof CodeReviewSchema>;
