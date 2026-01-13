/**
 * AI 模块常量定义
 *
 * 包含依赖注入 Token 和枚举类型
 */

/**
 * AI Provider 服务注入 Token
 * 用于在 NestJS IoC 容器中标识 Provider 抽象
 */
export const AI_PROVIDER = 'AI_PROVIDER';

/**
 * AI Provider 工厂注入 Token
 * 用于动态获取不同厂商的 Provider 实例
 */
export const AI_PROVIDER_FACTORY = 'AI_PROVIDER_FACTORY';

/**
 * Tool Registry 注入 Token
 */
export const TOOL_REGISTRY = 'TOOL_REGISTRY';

/**
 * 支持的 AI 提供商枚举
 */
export enum AiProvider {
  DEEPSEEK = 'deepseek',
  QWEN = 'qwen',
  GLM = 'glm',
  MINIMAX = 'minimax',
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  GOOGLE = 'google',
}

/**
 * 流式输出块类型枚举
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
