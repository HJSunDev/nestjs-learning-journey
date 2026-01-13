/**
 * 工具参数 Schema 定义
 * 遵循 JSON Schema 规范
 */
export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, ToolPropertySchema>;
  required?: string[];
}

/**
 * 工具属性 Schema
 */
export interface ToolPropertySchema {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
  items?: ToolPropertySchema;
}

/**
 * 工具定义
 * 用于向 AI 模型描述可用的工具
 */
export interface ToolDefinition {
  /** 工具唯一名称 */
  name: string;
  /** 工具描述（供 AI 理解用途） */
  description: string;
  /** 参数 Schema */
  parameters: ToolParameterSchema;
}

/**
 * 工具执行上下文
 * 提供执行工具时可能需要的上下文信息
 */
export interface ToolExecutionContext {
  /** 当前用户 ID */
  userId?: string;
  /** 会话 ID */
  sessionId?: string;
  /** 额外上下文数据 */
  metadata?: Record<string, unknown>;
}

/**
 * AI 工具抽象接口
 *
 * 所有可被 AI 调用的工具都需实现此接口
 * 工具执行结果将返回给 AI 继续推理
 */
export interface IAiTool {
  /**
   * 工具唯一名称
   * 用于 AI 调用时的标识
   */
  readonly name: string;

  /**
   * 获取工具定义
   * 用于向 AI 模型描述此工具
   */
  getDefinition(): ToolDefinition;

  /**
   * 执行工具
   * @param args AI 传入的参数
   * @param context 执行上下文
   * @returns 执行结果（将返回给 AI）
   */
  execute(
    args: Record<string, unknown>,
    context?: ToolExecutionContext,
  ): Promise<unknown>;
}
