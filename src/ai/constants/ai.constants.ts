/**
 * AI 模块常量定义
 *
 * 包含依赖注入 Token 和枚举类型
 */

/**
 * Tool Registry 注入 Token
 */
export const TOOL_REGISTRY = 'TOOL_REGISTRY';

/**
 * 支持的 AI 提供商枚举
 *
 * 仅包含已适配并经过验证的厂商。
 * 每个枚举值对应 AiModelFactory 中的一个工厂方法。
 */
export enum AiProvider {
  SILICONFLOW = 'siliconflow',
  DEEPSEEK = 'deepseek',
  QWEN = 'qwen',
  MOONSHOT = 'moonshot',
  GLM = 'glm',
}

/**
 * 流式输出块类型枚举
 *
 * 用于 SSE 流式响应中标识每个数据块的语义类型，
 * 前端据此决定如何渲染（如推理过程折叠显示、文本逐字输出等）。
 */
export enum StreamChunkType {
  /** 推理/思考过程 */
  REASONING = 'reasoning',
  /** 正式文本内容 */
  TEXT = 'text',
  /** 工具调用请求 */
  TOOL_CALL = 'tool_call',
  /** 工具调用结果 */
  TOOL_RESULT = 'tool_result',
  /** 流结束标记 */
  DONE = 'done',
  /** 错误信息 */
  ERROR = 'error',
  /** 元信息（线程 ID 等结构化元数据） */
  META = 'meta',
}

/**
 * 模型推理模式枚举
 *
 * 区分模型的推理能力类型，工厂层据此决定是否以及如何构造推理参数：
 * - NONE:    不具备推理能力
 * - ALWAYS:  始终推理（如 deepseek-reasoner），选对模型即开启，无需额外参数
 * - HYBRID:  可选推理（如 qwen-plus），需通过 API 参数显式开启
 */
export enum ReasoningMode {
  NONE = 'none',
  ALWAYS = 'always',
  HYBRID = 'hybrid',
}

/**
 * 消息角色枚举
 */
export enum MessageRole {
  SYSTEM = 'system',
  USER = 'user',
  ASSISTANT = 'assistant',
  TOOL = 'tool',
}
