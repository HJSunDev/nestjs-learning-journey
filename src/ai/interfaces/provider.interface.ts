import { StreamChunkType, MessageRole } from '../constants';

/**
 * 消息结构
 *
 * 用于 API 层的消息表示。LangChain 内部使用 HumanMessage/AIMessage 等类型，
 * 此接口用于控制器和服务层之间的数据传递。
 */
export interface Message {
  role: MessageRole | string;
  content: string;
  /** 工具调用 ID（仅 tool 角色使用） */
  toolCallId?: string;
}

/**
 * 流式输出块
 *
 * 统一的 SSE 流式响应数据结构，适用于所有对话场景（普通对话、推理对话、工具调用）。
 */
export interface StreamChunk {
  /** 块类型 */
  type: StreamChunkType | string;
  /** 文本内容（text/reasoning 类型） */
  content?: string;
  /** 工具调用信息（tool_call 类型） */
  toolCall?: ToolCallInfo;
  /** 工具执行结果（tool_result 类型） */
  toolResult?: ToolResultInfo;
  /** 错误信息（error 类型） */
  error?: string;
}

/**
 * 工具调用信息
 */
export interface ToolCallInfo {
  /** 调用 ID */
  id: string;
  /** 工具名称 */
  name: string;
  /** 调用参数 */
  arguments: Record<string, unknown>;
}

/**
 * 工具执行结果
 */
export interface ToolResultInfo {
  /** 对应的调用 ID */
  toolCallId: string;
  /** 工具名称 */
  name: string;
  /** 执行结果 */
  result: unknown;
}

/**
 * Token 使用统计
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
