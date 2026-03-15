import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * 模型创建参数
 *
 * 从 Factory 传递给 Adapter 的完全解析后的参数。
 * Factory 负责从 ConfigService 和 PROVIDER_REGISTRY 解析出这些值，
 * Adapter 只关心如何用这些参数创建 LangChain 模型实例。
 */
export interface AdapterModelParams {
  apiKey: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  streaming?: boolean;
  maxTokens?: number;
  /**
   * 透传到 LangChain 模型的额外参数
   *
   * 对 OpenAI 兼容模型，这些参数通过 modelKwargs 注入请求体；
   * 对 Anthropic 等其他协议，Adapter 自行决定如何映射。
   */
  modelKwargs?: Record<string, unknown>;
  /** 单次 HTTP 请求超时（毫秒），传递给底层 HTTP 客户端（如 Axios） */
  timeout?: number;
}

/**
 * 提供商协议适配器接口
 *
 * 隔离 Factory 与具体 LangChain 模型类之间的耦合。
 * 每种 API 协议（OpenAI-compatible、Anthropic、Google 等）
 * 实现一个 Adapter，封装该协议对应的 LangChain 类选择和构造逻辑。
 *
 * 设计要点：
 * - Factory 只依赖此接口，不直接 import 任何 LangChain 模型类
 * - 新增协议类型只需新增 Adapter 实现 + 注册到 PROVIDER_REGISTRY
 * - Adapter 是无状态的，可被多个 provider 共享（如所有 OpenAI 兼容厂商共享同一个 Adapter 实例）
 */
export interface IProviderAdapter {
  /**
   * 创建 LangChain Chat Model 实例
   *
   * @param params 完全解析后的模型创建参数
   * @returns LangChain BaseChatModel 实例
   */
  createModel(params: AdapterModelParams): BaseChatModel;
}
