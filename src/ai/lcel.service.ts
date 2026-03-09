import { Injectable, Logger } from '@nestjs/common';
import type { AIMessageChunk } from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import { AiModelFactory } from './factories/model.factory';
import { ReasoningNormalizer } from './normalizers/reasoning.normalizer';
import { ChatChainBuilder } from './chains';
import { AiProvider, ReasoningMode, StreamChunkType } from './constants';
import { MODEL_REGISTRY } from './constants/model-registry';
import {
  ChatRequestDto,
  QuickChatRequestDto,
  ChatResponseDto,
  ReasoningResponseDto,
} from './dto';
import { Observable, Subject } from 'rxjs';
import { StreamChunk } from './interfaces';

/**
 * LCEL 管道服务层 (041 章节专享)
 *
 * 与 038 章节的 AiService 完全隔离，专门用于演示声明式 LCEL 管道架构。
 * 核心差异：
 * - 不再直接调用 model.invoke(messages)
 * - 委托 ChatChainBuilder 组装 prompt.pipe(model) 管道
 * - 将 executeStream 的输入从 BaseChatModel 提升为 Runnable 接口
 */
@Injectable()
export class LcelService {
  private readonly logger = new Logger(LcelService.name);

  constructor(
    private readonly modelFactory: AiModelFactory,
    private readonly reasoningNormalizer: ReasoningNormalizer,
    private readonly chainBuilder: ChatChainBuilder,
  ) {}

  /**
   * 标准对话（LCEL 管道版）
   *
   * @param dto 对话请求参数
   * @returns 完整的对话响应
   */
  async chat(dto: ChatRequestDto): Promise<ChatResponseDto> {
    this.logger.log(
      `[LCEL] 调用聊天接口，提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    // 调用 resolveModelKwargs 以根据模型定义和 enableReasoning 参数，确定是否需要注入推理参数（如 hybrid/always 模型需要特殊 kwargs 激活推理功能，none 类型模型或未启用时则忽略）
    const modelKwargs = this.resolveModelKwargs(
      dto.provider,
      dto.model,
      dto.enableReasoning,
    );

    const model = this.modelFactory.createChatModel(dto.provider, {
      model: dto.model,
      temperature: dto.temperature,
      maxTokens: dto.maxTokens,
      modelKwargs,
    });

    const { chain, input } = this.chainBuilder.buildChatChain(
      model,
      dto.messages,
      dto.systemPrompt,
    );
    const result = (await chain.invoke(input)) as AIMessageChunk;

    const normalized = this.reasoningNormalizer.normalize(
      dto.provider,
      result as unknown as Record<string, unknown>,
    );

    return {
      content: normalized.content,
      reasoning: normalized.reasoning ?? undefined,
      usage: this.extractTokenUsage(result),
      finishReason: this.extractFinishReason(result),
    };
  }

  /**
   * 快速对话（LCEL 管道版，演示 {input} 模板变量）
   *
   * @param dto 快速对话请求参数
   * @returns 完整的对话响应
   */
  async quickChat(dto: QuickChatRequestDto): Promise<ChatResponseDto> {
    this.logger.log(
      `[LCEL] 调用快速聊天接口，提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    const model = this.modelFactory.createChatModel(dto.provider, {
      model: dto.model,
      temperature: dto.temperature,
    });

    const { chain, input } = this.chainBuilder.buildQuickChatChain(
      model,
      dto.prompt,
      dto.systemPrompt,
    );
    const result = (await chain.invoke(input)) as AIMessageChunk;

    const normalized = this.reasoningNormalizer.normalize(
      dto.provider,
      result as unknown as Record<string, unknown>,
    );

    return {
      content: normalized.content,
      reasoning: normalized.reasoning ?? undefined,
      usage: this.extractTokenUsage(result),
      finishReason: this.extractFinishReason(result),
    };
  }

  /**
   * 推理对话（LCEL 管道版）
   *
   * @param dto 对话请求参数
   * @returns 包含推理过程的响应
   */
  async reasoningChat(dto: ChatRequestDto): Promise<ReasoningResponseDto> {
    this.logger.log(
      `[LCEL] 调用推理聊天接口，提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    const modelKwargs = this.resolveModelKwargs(dto.provider, dto.model, true);
    const model = this.modelFactory.createChatModel(dto.provider, {
      model: dto.model,
      temperature: dto.temperature,
      maxTokens: dto.maxTokens,
      modelKwargs,
    });

    const { chain, input } = this.chainBuilder.buildChatChain(
      model,
      dto.messages,
      dto.systemPrompt,
    );
    const result = (await chain.invoke(input)) as AIMessageChunk;

    const normalized = this.reasoningNormalizer.normalize(
      dto.provider,
      result as unknown as Record<string, unknown>,
    );

    return {
      content: normalized.content,
      reasoning: normalized.reasoning ?? '模型未返回推理过程',
      usage: this.extractTokenUsage(result),
      finishReason: this.extractFinishReason(result),
    };
  }

  /**
   * 流式对话（LCEL 管道版）
   *
   * @param dto 对话请求参数
   * @returns StreamChunk 的 Observable 流
   */
  streamChat(dto: ChatRequestDto): Observable<StreamChunk> {
    const subject = new Subject<StreamChunk>();
    const modelKwargs = this.resolveModelKwargs(
      dto.provider,
      dto.model,
      dto.enableReasoning,
    );
    const model = this.modelFactory.createChatModel(dto.provider, {
      model: dto.model,
      streaming: true,
      maxTokens: dto.maxTokens,
      modelKwargs,
    });

    const { chain, input } = this.chainBuilder.buildChatChain(
      model,
      dto.messages,
      dto.systemPrompt,
    );

    this.logger.log(
      `[LCEL] 开始流式对话，提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    void this.executeStream(chain, dto.provider, input, subject);

    return subject.asObservable();
  }

  /**
   * 流式推理对话（LCEL 管道版）
   *
   * @param dto 对话请求参数
   * @returns StreamChunk 的 Observable 流
   */
  streamReasoningChat(dto: ChatRequestDto): Observable<StreamChunk> {
    const subject = new Subject<StreamChunk>();
    const modelKwargs = this.resolveModelKwargs(dto.provider, dto.model, true);
    const model = this.modelFactory.createChatModel(dto.provider, {
      model: dto.model,
      streaming: true,
      maxTokens: dto.maxTokens,
      modelKwargs,
    });

    const { chain, input } = this.chainBuilder.buildChatChain(
      model,
      dto.messages,
      dto.systemPrompt,
    );

    this.logger.log(
      `[LCEL] 开始流式推理对话，提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    void this.executeStream(chain, dto.provider, input, subject);

    return subject.asObservable();
  }

  // ============================================================
  // 内部方法 (为保持 038 纯净，在此处克隆工具方法，遵循隔离原则)
  // ============================================================

  private resolveModelKwargs(
    provider: AiProvider,
    modelId: string,
    enableReasoning?: boolean,
  ): Record<string, unknown> | undefined {
    if (!enableReasoning) return undefined;

    const modelDef = MODEL_REGISTRY.find(
      (m) => m.id === modelId && m.provider === provider,
    );

    if (
      modelDef?.capabilities.reasoningMode === ReasoningMode.HYBRID &&
      modelDef.reasoningKwargs
    ) {
      return modelDef.reasoningKwargs;
    }

    return undefined;
  }

  /**
   * 处理 LCEL 链的流式输出并推送到 RxJS Subject
   *
   * 接收泛化的 Runnable（而非 BaseChatModel），使其可与任意 LCEL 管道配合。
   */
  private async executeStream(
    chain: Runnable,
    provider: string,
    chainInput: Record<string, unknown>,
    subject: Subject<StreamChunk>,
  ) {
    try {
      const stream = await chain.stream(chainInput);

      let usage: ReturnType<typeof this.extractTokenUsage>;
      let finishReason: string | undefined;

      for await (const chunk of stream) {
        const aiChunk = chunk as AIMessageChunk;

        const currentUsage = this.extractTokenUsage(aiChunk);
        if (currentUsage) usage = currentUsage;

        const currentFinishReason = this.extractFinishReason(aiChunk);
        if (currentFinishReason) finishReason = currentFinishReason;

        const normalized = this.reasoningNormalizer.normalize(
          provider,
          aiChunk as unknown as Record<string, unknown>,
        );

        if (normalized.reasoning) {
          subject.next({
            type: StreamChunkType.REASONING,
            content: normalized.reasoning,
          });
        }

        if (normalized.content) {
          subject.next({
            type: StreamChunkType.TEXT,
            content: normalized.content,
          });
        }
      }

      subject.next({
        type: StreamChunkType.DONE,
        usage,
        finishReason,
      });
      subject.complete();
    } catch (error) {
      this.logger.error('流式处理发生错误', error);
      subject.next({
        type: StreamChunkType.ERROR,
        error: error instanceof Error ? error.message : String(error),
      });
      subject.complete();
    }
  }

  private extractTokenUsage(
    result: AIMessageChunk,
  ): ChatResponseDto['usage'] | undefined {
    const usageMeta = result.usage_metadata;
    if (usageMeta) {
      return {
        promptTokens: usageMeta.input_tokens ?? 0,
        completionTokens: usageMeta.output_tokens ?? 0,
        totalTokens: usageMeta.total_tokens ?? 0,
      };
    }

    const metadata = result.response_metadata as
      | Record<string, unknown>
      | undefined;
    if (!metadata) return undefined;

    const usage = metadata.tokenUsage as Record<string, number> | undefined;
    if (!usage) return undefined;

    return {
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
    };
  }

  private extractFinishReason(result: AIMessageChunk): string | undefined {
    const metadata = result.response_metadata as
      | Record<string, unknown>
      | undefined;
    if (!metadata) return undefined;

    const reason = metadata.finish_reason;
    return typeof reason === 'string' ? reason : undefined;
  }
}
