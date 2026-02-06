import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * 临时类型别名
 *
 * LangChain 尚未安装，此处用 any 占位。
 * 安装 @langchain/core 后应替换为：
 * import { BaseChatModel } from '@langchain/core/language_models/chat_models';
 */
export type BaseChatModel = any;

/**
 * AI 模型工厂
 *
 * 封装「如何创建模型实例」的复杂逻辑（API Key 获取、参数配置、Base URL 设置），
 * 对上层暴露统一的 createChatModel(provider, options) 接口。
 *
 * 返回的实例统一遵循 LangChain 的 BaseChatModel 抽象，
 * 调用方无需关心底层是 ChatDeepSeek 还是 ChatAlibabaTongyi。
 */
@Injectable()
export class AiModelFactory {
  private readonly logger = new Logger(AiModelFactory.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * 根据提供商标识创建 LangChain Chat Model 实例
   *
   * @param provider 提供商 ID (如 'deepseek', 'qwen', 'moonshot', 'glm')
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
      case 'deepseek':
        return this.createDeepSeekModel(apiKey, options);
      case 'qwen':
        return this.createQwenModel(apiKey, options);
      case 'moonshot':
        return this.createMoonshotModel(apiKey, options);
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
    return this.configService.get<string>(
      `ai.providers.${provider}.baseUrl`,
    );
  }

  // ============================================================
  // 工厂方法（LangChain 依赖安装后启用真实实现）
  // ============================================================

  private createDeepSeekModel(apiKey: string, options: any): BaseChatModel {
    // TODO: 安装 @langchain/deepseek 后启用
    // return new ChatDeepSeek({
    //   apiKey,
    //   model: options.model || 'deepseek-chat',
    //   temperature: options.temperature,
    //   streaming: options.streaming,
    // });
    this.logger.debug(
      `创建 DeepSeek 模型 [model=${options.model ?? 'deepseek-chat'}]`,
    );
    return { provider: 'deepseek', ...options };
  }

  private createQwenModel(apiKey: string, options: any): BaseChatModel {
    // TODO: 安装 @langchain/community 后启用
    // return new ChatAlibabaTongyi({
    //   alibabaApiKey: apiKey,
    //   model: options.model || 'qwen-turbo',
    //   temperature: options.temperature,
    //   streaming: options.streaming,
    // });
    this.logger.debug(
      `创建 Qwen 模型 [model=${options.model ?? 'qwen-turbo'}]`,
    );
    return { provider: 'qwen', ...options };
  }

  private createMoonshotModel(apiKey: string, options: any): BaseChatModel {
    // TODO: 安装 @langchain/community 后启用
    // return new ChatMoonshot({
    //   apiKey,
    //   model: options.model || 'moonshot-v1-8k',
    //   temperature: options.temperature,
    //   streaming: options.streaming,
    // });
    this.logger.debug(
      `创建 Moonshot 模型 [model=${options.model ?? 'moonshot-v1-8k'}]`,
    );
    return { provider: 'moonshot', ...options };
  }

  private createZhipuModel(apiKey: string, options: any): BaseChatModel {
    // TODO: 安装 @langchain/community 后启用
    // return new ChatZhipuAI({
    //   zhipuAIApiKey: apiKey,
    //   model: options.model || 'glm-4',
    //   temperature: options.temperature,
    //   streaming: options.streaming,
    // });
    this.logger.debug(
      `创建 Zhipu (GLM) 模型 [model=${options.model ?? 'glm-4'}]`,
    );
    return { provider: 'glm', ...options };
  }
}
