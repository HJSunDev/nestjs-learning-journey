import { Observable } from 'rxjs';
import { StreamChunkType, MessageRole } from '../constants';

/**
 * 消息结构
 * 用于多轮对话的消息历史
 */
export interface Message {
  role: MessageRole | string;
  content: string;
  /** 工具调用 ID（仅 tool 角色使用） */
  toolCallId?: string;
}

/**
 * 生成选项
 * 传递给 Provider 的统一参数结构
 */
export interface GenerateOptions {
  /** 模型名称 */
  model: string;
  /** 消息历史 */
  messages: Message[];
  /** 系统提示词 */
  systemPrompt?: string;
  /** 温度参数 (0-2) */
  temperature?: number;
  /** 最大输出 Token 数 */
  maxTokens?: number;
  /** 是否启用推理模式（获取思考过程） */
  enableReasoning?: boolean;
  /** 启用的工具名称列表 */
  tools?: string[];
}

/**
 * 流式输出块
 * 统一的流式响应数据结构
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
 * 非流式生成结果
 */
export interface GenerateResult {
  /** 最终文本内容 */
  content: string;
  /** 推理/思考过程（如有） */
  reasoning?: string;
  /** 工具调用列表（如有） */
  toolCalls?: ToolCallInfo[];
  /** Token 使用统计 */
  usage?: TokenUsage;
  /** 完成原因 */
  finishReason?: string;
}

/**
 * Token 使用统计
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * AI Provider 抽象接口
 *
 * 遵循 DIP 原则：业务代码依赖此接口，而非具体实现
 * 所有模型提供商（DeepSeek、Qwen、GLM 等）均需实现此接口
 */
export interface IAiProvider {
  /**
   * 提供商标识
   */
  readonly providerId: string;

  /**
   * 支持的模型列表
   */
  readonly supportedModels: string[];

  /**
   * 非流式文本生成
   * @param options 生成选项
   * @returns 生成结果
   */
  generateText(options: GenerateOptions): Promise<GenerateResult>;

  /**
   * 流式文本生成
   * 返回 RxJS Observable，便于与 NestJS 生态集成
   * @param options 生成选项
   * @returns 流式输出 Observable
   */
  streamText(options: GenerateOptions): Observable<StreamChunk>;

  /**
   * 检查模型是否支持
   * @param model 模型名称
   */
  isModelSupported(model: string): boolean;
}
