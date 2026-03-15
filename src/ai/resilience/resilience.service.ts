import { Injectable, Logger } from '@nestjs/common';
import type { Runnable } from '@langchain/core/runnables';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AiModelFactory } from '../factories/model.factory';
import type { RetryPolicy, FallbackConfig } from './resilience.config';
import { DEFAULT_RETRY_POLICY } from './resilience.config';

/**
 * 韧性服务
 *
 * 将 LangChain 的 .withRetry() 和 .withFallbacks() 原语封装为
 * NestJS 可注入的服务，提供声明式的韧性包装能力。
 *
 * 设计决策：
 * - 不侵入 ChatChainBuilder 的链组装逻辑，而是在链组装完成后
 *   通过组合式 API 叠加韧性能力（装饰者模式）
 * - 重试和降级互为独立的关注点，可单独使用也可组合使用
 * - 降级链需要创建新的模型实例，因此依赖 AiModelFactory
 */
@Injectable()
export class ResilienceService {
  private readonly logger = new Logger(ResilienceService.name);

  constructor(private readonly modelFactory: AiModelFactory) {}

  /**
   * 为 Runnable 添加重试能力
   *
   * 底层调用 LangChain 的 .withRetry()，对瞬时错误（如 429 限流、502 网关错误）
   * 自动重试。LangChain 内部使用指数退避策略。
   *
   * 注意：流式调用中，只有在流创建阶段（.stream() 返回前）的错误才会触发重试，
   * 流开始后的错误不会触发重试（这是 LangChain 的设计限制）。
   *
   * @param runnable  要包装的可执行对象（链、模型等）
   * @param policy    重试策略配置
   * @returns 带重试能力的新 Runnable
   */
  withRetry<RunInput, RunOutput>(
    runnable: Runnable<RunInput, RunOutput>,
    policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  ): Runnable<RunInput, RunOutput> {
    this.logger.debug(`应用重试策略: maxAttempts=${policy.maxAttempts}`);

    return runnable.withRetry({
      stopAfterAttempt: policy.maxAttempts + 1,
      onFailedAttempt: (error: Error, attempt: number) => {
        this.logger.warn(
          `重试第 ${attempt}/${policy.maxAttempts} 次: ${error.message}`,
        );
      },
    }) as Runnable<RunInput, RunOutput>;
  }

  /**
   * 为 Runnable 添加降级能力
   *
   * 底层调用 LangChain 的 .withFallbacks()，当主链失败后按顺序尝试备用链。
   * 常见用法：主模型不可用时自动切换到备用模型/提供商。
   *
   * @param primary     主 Runnable
   * @param fallbacks   降级 Runnable 列表（按优先级排序）
   * @returns 带降级能力的新 Runnable
   */
  withFallbacks<RunInput, RunOutput>(
    primary: Runnable<RunInput, RunOutput>,
    fallbacks: Runnable<RunInput, RunOutput>[],
  ): Runnable<RunInput, RunOutput> {
    if (fallbacks.length === 0) return primary;

    this.logger.debug(`应用降级策略: ${fallbacks.length} 个备用链`);

    return primary.withFallbacks({
      fallbacks,
    }) as Runnable<RunInput, RunOutput>;
  }

  /**
   * 创建降级模型实例
   *
   * 根据 FallbackConfig 列表，通过 AiModelFactory 创建备用模型实例。
   * 失败的配置（如 API Key 未配置）会被静默跳过并记录警告，
   * 避免降级配置错误导致主链也无法使用。
   *
   * @param configs         降级配置列表
   * @param primaryOptions  主模型的创建选项（温度、streaming 等继承给降级模型）
   * @returns 成功创建的降级模型实例列表
   */
  createFallbackModels(
    configs: FallbackConfig[],
    primaryOptions: {
      temperature?: number;
      streaming?: boolean;
      maxTokens?: number;
    } = {},
  ): BaseChatModel[] {
    const models: BaseChatModel[] = [];

    for (const config of configs) {
      try {
        const model = this.modelFactory.createChatModel(config.provider, {
          model: config.model,
          temperature: primaryOptions.temperature,
          streaming: primaryOptions.streaming,
          maxTokens: primaryOptions.maxTokens,
        });
        models.push(model);
        this.logger.debug(
          `降级模型就绪: provider=${config.provider}, model=${config.model ?? 'default'}`,
        );
      } catch (error) {
        this.logger.warn(
          `降级模型创建失败 (provider=${config.provider}): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return models;
  }
}
