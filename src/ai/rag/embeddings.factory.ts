import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIEmbeddings } from '@langchain/openai';

/**
 * Embedding 模型工厂
 *
 * 基于 @langchain/openai 的 OpenAIEmbeddings 创建向量化实例。
 * SiliconFlow 提供 OpenAI 兼容的 /v1/embeddings 端点，
 * 通过 configuration.baseURL 指向 SiliconFlow 即可复用 OpenAIEmbeddings 类。
 *
 * 与 Chat Model 工厂（AiModelFactory）的设计差异：
 * - Chat Model 支持多厂商切换（SiliconFlow/DeepSeek/Qwen/...），需要 Provider Registry
 * - Embedding 模型通常全局固定一个（向量空间一致性要求），无需多厂商切换
 * - 因此采用更简单的单例工厂，直接读取配置创建实例
 */
@Injectable()
export class EmbeddingsFactory {
  private readonly logger = new Logger(EmbeddingsFactory.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * 创建 Embedding 模型实例
   *
   * 使用 SiliconFlow 提供的 Qwen3-Embedding-8B 模型（默认），
   * 通过 OpenAI 兼容 API 调用。
   *
   * @param options 可选覆盖参数
   * @returns OpenAIEmbeddings 实例
   */
  create(options?: { model?: string; dimensions?: number }): OpenAIEmbeddings {
    // ConfigService.get(key, defaultValue)
    // - key: 配置项路径，对应 ai.config.ts 中的层级结构
    // - defaultValue: 当配置项不存在时的兜底值（非从配置中读取）
    const defaultProvider = this.configService.get<string>(
      'ai.defaultProvider',
      'siliconflow',
    );
    const apiKey = this.configService.get<string>(
      `ai.providers.${defaultProvider}.apiKey`,
    );
    const baseURL = this.configService.get<string>(
      `ai.providers.${defaultProvider}.baseUrl`,
    );
    const model =
      options?.model ||
      this.configService.get<string>('ai.rag.embedding.model');
    // dimensions: 向量维度（embedding 维度）
    // 将文本转换为向量时，输出的向量长度。例如 1024 表示一个包含 1024 个浮点数的数组
    // 维度越高精度越好，但存储成本和计算开销也越大
    const dimensions =
      options?.dimensions ||
      this.configService.get<number>('ai.rag.embedding.dimensions');

    if (!apiKey) {
      throw new Error(
        `未配置 ${defaultProvider} 的 API Key，Embedding 模型无法初始化`,
      );
    }

    this.logger.log(
      `创建 Embedding 模型 [model=${model}, dimensions=${dimensions}, ` +
        `provider=${defaultProvider}]`,
    );

    // 创建 OpenAIEmbeddings 实例
    return new OpenAIEmbeddings({
      // model: 模型名称
      model,
      // dimensions: 向量维度
      dimensions,
      // apiKey: API Key
      apiKey,
      // configuration: 配置,baseURL: 基础 URL,用于指定模型 API 的 URL
      configuration: { baseURL },
    });
  }
}
