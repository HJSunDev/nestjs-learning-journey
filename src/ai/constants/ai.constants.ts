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
