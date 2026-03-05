import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatDeepSeek } from '@langchain/deepseek';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * AI 模型工厂
 *
 * 基于 EXP-003 的架构决策，所有 OpenAI 兼容的厂商统一使用 ChatDeepSeek，
 * 通过 configuration.baseURL 切换目标厂商或聚合平台（如硅基流动），
 * 避免 @langchain/community 的实现质量问题（EXP-002）和
 * @langchain/openai 的字段丢失问题（EXP-001）。
 *
 * 返回的实例统一遵循 LangChain 的 BaseChatModel 抽象，
 * 调用方无需关心底层连接的是哪家厂商。
 */
@Injectable()
export class AiModelFactory {
  private readonly logger = new Logger(AiModelFactory.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * 根据提供商标识创建 LangChain Chat Model 实例
   *
   * @param provider 提供商 ID (如 'siliconflow', 'deepseek', 'qwen', 'moonshot', 'glm')
   * @param options  模型的额外选项 (如 temperature, model, streaming)
   * @returns LangChain BaseChatModel 实例
   * @throws Error 当提供商不支持或 API Key 未配置时
   */
  createChatModel(
    provider: string,
    options: Record<string, any> = {},
  ): BaseChatModel {
    const apiKey = this.getApiKey(provider);

    switch (provider) {
      case 'siliconflow':
        return this.createSiliconFlowModel(apiKey, options);
      case 'moonshot':
        return this.createMoonshotModel(apiKey, options);
      case 'deepseek':
        return this.createDeepSeekModel(apiKey, options);
      case 'qwen':
        return this.createQwenModel(apiKey, options);
      case 'glm':
        return this.createZhipuModel(apiKey, options);
      default:
        throw new Error(`不支持的 AI 提供商: ${provider}`);
    }
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

  // ============================================================
  // 工厂方法
  // 基于 EXP-003：统一使用 ChatDeepSeek + baseURL 切换厂商
  // ============================================================

  /**
   * 创建 SiliconFlow（硅基流动）模型
   *
   * 硅基流动是模型聚合平台，一个 API Key 可调用多厂商模型。
   * 模型名称需带厂商前缀，如 MiniMaxAI/MiniMax-M2.5。
   */
  private createSiliconFlowModel(
    apiKey: string,
    options: Record<string, unknown>,
  ): BaseChatModel {
    const model = (options.model as string) || 'Pro/MiniMaxAI/MiniMax-M2.5';
    this.logger.debug(`创建 SiliconFlow 模型 [model=${model}]`);

    return new ChatDeepSeek({
      apiKey,
      model,
      temperature: options.temperature as number | undefined,
      streaming: options.streaming as boolean | undefined,
      maxTokens: options.maxTokens as number | undefined,
      configuration: {
        baseURL:
          this.getBaseUrl('siliconflow') || 'https://api.siliconflow.cn/v1',
      },
    });
  }

  /**
   * 创建 Moonshot (Kimi) 模型
   *
   * 通过 ChatDeepSeek + baseURL 适配（EXP-003），
   * Moonshot API 完全兼容 OpenAI Chat Completions 格式。
   */
  private createMoonshotModel(
    apiKey: string,
    options: Record<string, unknown>,
  ): BaseChatModel {
    const model = (options.model as string) || 'kimi-k2.5';
    this.logger.debug(`创建 Moonshot 模型 [model=${model}]`);

    return new ChatDeepSeek({
      apiKey,
      model,
      temperature: options.temperature as number | undefined,
      streaming: options.streaming as boolean | undefined,
      maxTokens: options.maxTokens as number | undefined,
      configuration: {
        baseURL: this.getBaseUrl('moonshot') || 'https://api.moonshot.cn/v1',
      },
    });
  }

  /**
   * 创建 DeepSeek 模型（原生适配，无需 baseURL 覆盖）
   */
  private createDeepSeekModel(
    apiKey: string,
    options: Record<string, unknown>,
  ): BaseChatModel {
    const model = (options.model as string) || 'deepseek-chat';
    this.logger.debug(`创建 DeepSeek 模型 [model=${model}]`);

    return new ChatDeepSeek({
      apiKey,
      model,
      temperature: options.temperature as number | undefined,
      streaming: options.streaming as boolean | undefined,
      maxTokens: options.maxTokens as number | undefined,
    });
  }

  /**
   * 创建 Qwen (通义千问) 模型
   *
   * 通过 ChatDeepSeek + baseURL 适配（EXP-003），
   * Qwen 的推理功能需通过 modelKwargs 传入 enable_thinking 参数。
   */
  private createQwenModel(
    apiKey: string,
    options: Record<string, unknown>,
  ): BaseChatModel {
    const model = (options.model as string) || 'qwen-plus';
    this.logger.debug(`创建 Qwen 模型 [model=${model}]`);

    return new ChatDeepSeek({
      apiKey,
      model,
      temperature: options.temperature as number | undefined,
      streaming: options.streaming as boolean | undefined,
      maxTokens: options.maxTokens as number | undefined,
      configuration: {
        baseURL:
          this.getBaseUrl('qwen') ||
          'https://dashscope.aliyuncs.com/compatible-mode/v1',
      },
    });
  }

  /**
   * 创建智谱 GLM 模型
   *
   * 通过 ChatDeepSeek + baseURL 适配（EXP-003），
   * GLM 的推理功能需通过 modelKwargs 传入 thinking 配置。
   */
  private createZhipuModel(
    apiKey: string,
    options: Record<string, unknown>,
  ): BaseChatModel {
    const model = (options.model as string) || 'glm-4';
    this.logger.debug(`创建 Zhipu (GLM) 模型 [model=${model}]`);

    return new ChatDeepSeek({
      apiKey,
      model,
      temperature: options.temperature as number | undefined,
      streaming: options.streaming as boolean | undefined,
      maxTokens: options.maxTokens as number | undefined,
      configuration: {
        baseURL:
          this.getBaseUrl('glm') || 'https://open.bigmodel.cn/api/paas/v4',
      },
    });
  }
}
