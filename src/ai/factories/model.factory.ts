import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { IProviderAdapter } from '../providers/provider-adapter.interface';
import { OpenAICompatibleAdapter } from '../providers/openai-compatible.adapter';

/**
 * 提供商注册条目
 *
 * 将提供商标识映射到：
 * - adapter:        协议适配器（决定用哪个 LangChain 类创建模型）
 * - defaultModel:   该提供商的默认模型名称
 * - fallbackBaseUrl: baseURL 的回退值（env 未配置时使用）
 */
interface ProviderEntry {
  adapter: IProviderAdapter;
  defaultModel: string;
  fallbackBaseUrl?: string;
}

/**
 * 共享的 OpenAI 兼容协议适配器实例
 *
 * 所有遵循 OpenAI Chat Completions 规范的提供商共享同一个无状态适配器。
 * 未来接入 Anthropic/Google 等非 OpenAI 协议时，在此处新增对应适配器实例。
 */
const openAICompatible = new OpenAICompatibleAdapter();

/**
 * 提供商注册表
 *
 * 新增 OpenAI 兼容提供商：加一行配置即可，无需改动任何代码。
 * 新增非 OpenAI 协议提供商：创建新 Adapter，然后加一行配置。
 *
 * baseURL 配置优先级：env 环境变量 > fallbackBaseUrl > 无（使用 SDK 默认值）
 */
const PROVIDER_REGISTRY: Record<string, ProviderEntry> = {
  siliconflow: {
    adapter: openAICompatible,
    defaultModel: 'Pro/MiniMaxAI/MiniMax-M2.5',
    fallbackBaseUrl: 'https://api.siliconflow.cn/v1',
  },
  moonshot: {
    adapter: openAICompatible,
    defaultModel: 'kimi-k2.5',
    fallbackBaseUrl: 'https://api.moonshot.cn/v1',
  },
  deepseek: {
    adapter: openAICompatible,
    defaultModel: 'deepseek-chat',
  },
  qwen: {
    adapter: openAICompatible,
    defaultModel: 'qwen-plus',
    fallbackBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  glm: {
    adapter: openAICompatible,
    defaultModel: 'glm-4',
    fallbackBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  },
};

/**
 * 模型创建选项
 *
 * 工厂层只接收纯技术参数，不包含业务语义（如 enableReasoning）。
 * 推理相关的 modelKwargs 由 Service 层根据 ModelDefinition 解析后传入。
 */
export interface CreateModelOptions {
  model?: string;
  temperature?: number;
  streaming?: boolean;
  maxTokens?: number;
  /**
   * 透传到 LangChain 模型的额外参数
   *
   * 由 Service 层负责根据 ModelDefinition.reasoningKwargs 构造。
   */
  modelKwargs?: Record<string, unknown>;
  /** 单次 HTTP 请求超时（毫秒），未指定时使用 ai.timeout.perCallMs 全局默认值 */
  timeout?: number;
}

/**
 * AI 模型工厂
 *
 * 职责：根据 provider 标识，委托对应的协议适配器创建 LangChain ChatModel 实例。
 *
 * 设计要点：
 * - 工厂不直接 import 任何 LangChain 模型类（ChatDeepSeek、ChatAnthropic 等），
 *   具体的 LangChain 类选择由 IProviderAdapter 实现封装
 * - 工厂通过 PROVIDER_REGISTRY 查找适配器和默认配置，符合 OCP
 * - 推理参数由 Service 层解析后通过 modelKwargs 传入，工厂不含业务逻辑
 *
 * 扩展方式：
 * - 新增 OpenAI 兼容提供商：在 PROVIDER_REGISTRY 中添加一行
 * - 新增非 OpenAI 协议提供商：创建新 Adapter 实现 → 在 PROVIDER_REGISTRY 中引用
 */
@Injectable()
export class AiModelFactory {
  private readonly logger = new Logger(AiModelFactory.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * 根据提供商标识创建 LangChain Chat Model 实例
   *
   * @param provider 提供商 ID (如 'siliconflow', 'deepseek', 'qwen', 'moonshot', 'glm')
   * @param options  模型创建选项（model, temperature, streaming, maxTokens, modelKwargs）
   * @returns LangChain BaseChatModel 实例
   * @throws Error 当提供商不支持或 API Key 未配置时
   */
  createChatModel(
    provider: string,
    options: CreateModelOptions = {},
  ): BaseChatModel {
    const entry = PROVIDER_REGISTRY[provider];
    if (!entry) {
      throw new Error(`不支持的 AI 提供商: ${provider}`);
    }

    const apiKey = this.getApiKey(provider);
    const model = options.model || entry.defaultModel;
    const baseUrl = this.getBaseUrl(provider) || entry.fallbackBaseUrl;
    const timeout =
      options.timeout ?? this.configService.get<number>('ai.timeout.perCallMs');

    this.logger.debug(
      `创建模型 [provider=${provider}, model=${model}` +
        `${timeout ? `, timeout=${timeout}ms` : ''}` +
        `${options.modelKwargs ? `, kwargs=${JSON.stringify(options.modelKwargs)}` : ''}]`,
    );

    return entry.adapter.createModel({
      apiKey,
      model,
      baseUrl,
      temperature: options.temperature,
      streaming: options.streaming,
      maxTokens: options.maxTokens,
      modelKwargs: options.modelKwargs,
      timeout,
    });
  }

  /**
   * 从配置中获取指定提供商的 API Key
   *
   * 配置路径遵循 ai.providers.<provider>.apiKey 格式，
   * 通过 ConfigService 从环境变量中安全读取。
   */
  private getApiKey(provider: string): string {
    const key = this.configService.get<string>(
      `ai.providers.${provider}.apiKey`,
    );
    if (!key) {
      throw new Error(
        `未配置 ${provider} 的 API Key，请在 .env 中设置对应的环境变量`,
      );
    }
    return key;
  }

  /**
   * 从配置中获取指定提供商的 Base URL
   */
  private getBaseUrl(provider: string): string | undefined {
    return this.configService.get<string>(`ai.providers.${provider}.baseUrl`);
  }
}
