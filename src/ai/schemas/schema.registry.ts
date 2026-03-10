import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ZodObject, ZodRawShape } from 'zod';
import {
  SentimentAnalysisSchema,
  EntityExtractionSchema,
  ContentClassificationSchema,
  CodeReviewSchema,
} from './extraction.schemas';

/**
 * Schema 元数据
 *
 * 除 Zod Schema 本身外，还携带面向客户端的描述信息，
 * 供 GET /schemas 端点返回可用 Schema 列表。
 */
export interface SchemaEntry {
  /** Schema 唯一标识名，客户端通过此名称选择 */
  name: string;
  /** 面向用户的简短描述 */
  description: string;
  /** Zod Schema 实例 */
  schema: ZodObject<ZodRawShape>;
}

/**
 * Schema 列表项（不含 Zod 实例，面向 API 响应）
 */
export interface SchemaListItem {
  name: string;
  description: string;
  /** JSON Schema 格式的字段描述，便于客户端展示 */
  fields: Record<string, string>;
}

/**
 * 结构化输出 Schema 注册表
 *
 * 管理所有可用于 withStructuredOutput 的 Zod Schema。
 * 客户端通过 schemaName 选择预定义的 Schema，
 * 比传递动态 JSON Schema 更安全（防注入）、更可靠（编译时校验）。
 *
 * 扩展方式：在 constructor 中调用 register() 注册新 Schema 即可。
 */
@Injectable()
export class SchemaRegistry {
  private readonly logger = new Logger(SchemaRegistry.name);
  private readonly schemas = new Map<string, SchemaEntry>();

  constructor() {
    this.registerBuiltinSchemas();
  }

  /**
   * 注册内置的预定义 Schema
   */
  private registerBuiltinSchemas(): void {
    this.register({
      name: 'sentiment-analysis',
      description: '情感分析：识别文本的情感倾向、置信度和关键词',
      schema: SentimentAnalysisSchema as ZodObject<ZodRawShape>,
    });

    this.register({
      name: 'entity-extraction',
      description: '实体提取：从文本中提取人物、组织、地点和日期',
      schema: EntityExtractionSchema as ZodObject<ZodRawShape>,
    });

    this.register({
      name: 'content-classification',
      description: '内容分类：对文本进行分类、打标签并估算阅读时间',
      schema: ContentClassificationSchema as ZodObject<ZodRawShape>,
    });

    this.register({
      name: 'code-review',
      description: '代码审查：分析代码质量、识别问题并给出改进建议',
      schema: CodeReviewSchema as ZodObject<ZodRawShape>,
    });

    this.logger.log(`Schema 注册完成，共 ${this.schemas.size} 个可用 Schema`);
  }

  /**
   * 注册 Schema
   *
   * @param entry Schema 元数据（含 Zod 实例）
   */
  register(entry: SchemaEntry): void {
    if (this.schemas.has(entry.name)) {
      this.logger.warn(`Schema "${entry.name}" 已存在，将被覆盖`);
    }
    this.schemas.set(entry.name, entry);
  }

  /**
   * 按名称获取 Schema
   *
   * @param name Schema 名称
   * @returns Zod Schema 实例
   * @throws Error 当 Schema 不存在时
   */
  getSchema(name: string): ZodObject<ZodRawShape> {
    const entry = this.schemas.get(name);
    if (!entry) {
      const available = this.getNames().join(', ');
      throw new NotFoundException(
        `Schema "${name}" 不存在。可用的 Schema: ${available}`,
      );
    }
    return entry.schema;
  }

  /**
   * 获取所有已注册的 Schema 名称
   */
  getNames(): string[] {
    return Array.from(this.schemas.keys());
  }

  /**
   * 获取所有 Schema 的列表信息（面向 API 响应）
   *
   * 从 Zod Schema 的 shape 中提取字段名及 description，
   * 供客户端了解每个 Schema 的结构。
   */
  listSchemas(): SchemaListItem[] {
    return Array.from(this.schemas.values()).map((entry) => ({
      name: entry.name,
      description: entry.description,
      fields: this.extractFieldDescriptions(entry.schema),
    }));
  }

  /**
   * 从 Zod Schema 中提取字段描述映射表
   *
   * Zod Schema 的 shape 是一个对象，每个字段都是一个 ZodType。
   * 通过 `.describe()` 方法设置的描述信息存储在每个 ZodType 的内部。
   *
   * @example
   *
   * const schema = z.object({
   *   sentiment: z.enum(['positive', 'negative']).describe('情感倾向'),
   *   confidence: z.number().describe('置信度 (0-1)'),
   * });
   *
   * // schema.shape 结构：
   * // {
   * //   sentiment: ZodEnum { description: '情感倾向', ... },
   * //   confidence: ZodNumber { description: '置信度 (0-1)', ... },
   * // }
   *
   * extractFieldDescriptions(schema);
   * // 返回: { sentiment: '情感倾向', confidence: '置信度 (0-1)' }
   *
   * @param schema - ZodObject 实例，包含 .shape 属性
   * @returns 字段名 → 字段描述的映射表，供 API 响应使用
   */
  private extractFieldDescriptions(
    schema: ZodObject<ZodRawShape>,
  ): Record<string, string> {
    const fields: Record<string, string> = {};
    const shape = schema.shape;

    for (const [key, value] of Object.entries(shape)) {
      const desc = (value as { description?: string }).description;
      fields[key] = desc ?? '(no description)';
    }

    return fields;
  }

  /**
   * 获取已注册 Schema 数量
   */
  get size(): number {
    return this.schemas.size;
  }
}
