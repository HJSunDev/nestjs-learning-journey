import { Injectable, Logger } from '@nestjs/common';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessageChunk } from '@langchain/core/messages';
import { AiModelFactory } from './factories/model.factory';
import { ReasoningNormalizer } from './normalizers/reasoning.normalizer';
import { convertToLangChainMessages } from './utils';
import { AiProvider, MessageRole, StreamChunkType } from './constants';
import { MODEL_REGISTRY } from './constants/model-registry';
import {
  ChatRequestDto,
  QuickChatRequestDto,
  ChatResponseDto,
  ReasoningResponseDto,
  ModelListResponseDto,
} from './dto';
import { Observable, Subject } from 'rxjs';
import { StreamChunk, ModelDefinition } from './interfaces';

/**
 * AI 服务层
 *
 * 纯业务逻辑，不感知 HTTP 层。
 * 异常由 AiExceptionFilter 在 Controller 层统一拦截和转换。
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly modelFactory: AiModelFactory,
    private readonly reasoningNormalizer: ReasoningNormalizer,
  ) {}

  /**
   * 获取可用模型列表
   *
   * @param provider 可选，按 API 提供商筛选
   * @returns 模型列表及总数
   */
  getAvailableModels(provider?: AiProvider): ModelListResponseDto {
    let models: readonly ModelDefinition[] = MODEL_REGISTRY;

    if (provider) {
      models = models.filter((m) => m.provider === provider);
    }

    return {
      models: models as ModelDefinition[],
      total: models.length,
    };
  }

  /**
   * 标准对话（非流式）
   *
   * @param dto 对话请求参数
   * @returns 完整的对话响应
   */
  async chat(dto: ChatRequestDto): Promise<ChatResponseDto> {
    this.logger.log(
      `调用聊天接口，提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    const model = this.modelFactory.createChatModel(dto.provider, {
      model: dto.model,
      temperature: dto.temperature,
      maxTokens: dto.maxTokens,
    });

    const messages = convertToLangChainMessages(dto.messages, dto.systemPrompt);
    const result = await model.invoke(messages);
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
   * 快速对话（单轮）
   *
   * @param dto 快速对话请求参数
   * @returns 完整的对话响应
   */
  async quickChat(dto: QuickChatRequestDto): Promise<ChatResponseDto> {
    return this.chat({
      provider: dto.provider,
      model: dto.model,
      messages: [{ role: MessageRole.USER, content: dto.prompt }],
      systemPrompt: dto.systemPrompt,
      temperature: dto.temperature,
    });
  }

  /**
   * 推理对话（非流式）
   *
   * 使用支持思维链的模型，返回推理过程和最终答案。
   *
   * @param dto 对话请求参数
   * @returns 包含推理过程的响应
   */
  async reasoningChat(dto: ChatRequestDto): Promise<ReasoningResponseDto> {
    this.logger.log(
      `调用推理聊天接口，提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    const model = this.modelFactory.createChatModel(dto.provider, {
      model: dto.model,
      temperature: dto.temperature,
      maxTokens: dto.maxTokens,
    });

    const messages = convertToLangChainMessages(dto.messages, dto.systemPrompt);
    const result = await model.invoke(messages);
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
   * 流式对话
   *
   * @param dto 对话请求参数
   * @returns StreamChunk 的 Observable 流
   */
  streamChat(dto: ChatRequestDto): Observable<StreamChunk> {
    const subject = new Subject<StreamChunk>();
    const model = this.modelFactory.createChatModel(dto.provider, {
      model: dto.model,
      streaming: true,
      maxTokens: dto.maxTokens,
    });

    const messages = convertToLangChainMessages(dto.messages, dto.systemPrompt);

    this.logger.log(
      `开始流式对话，提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    void this.executeStream(model, dto.provider, messages, subject);

    return subject.asObservable();
  }

  /**
   * 流式推理对话
   *
   * @param dto 对话请求参数
   * @returns StreamChunk 的 Observable 流
   */
  streamReasoningChat(dto: ChatRequestDto): Observable<StreamChunk> {
    const subject = new Subject<StreamChunk>();
    const model = this.modelFactory.createChatModel(dto.provider, {
      model: dto.model,
      streaming: true,
      maxTokens: dto.maxTokens,
    });

    const messages = convertToLangChainMessages(dto.messages, dto.systemPrompt);

    this.logger.log(
      `开始流式推理对话，提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    void this.executeStream(model, dto.provider, messages, subject, true);

    return subject.asObservable();
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 处理 LangChain 流并推送到 RxJS Subject
   *
   * 流式场景的错误在此处 catch 并通过 SSE error 事件推送给客户端，
   * 因为流式响应已经开始写入，无法再改变 HTTP 状态码。
   */
  private async executeStream(
    model: BaseChatModel,
    provider: string,
    messages: ReturnType<typeof convertToLangChainMessages>,
    subject: Subject<StreamChunk>,
    includeReasoning = false,
  ) {
    try {
      const stream = await model.stream(messages);

      for await (const chunk of stream) {
        // 不同 provider 返回的 chunk 结构各异，统一归一化后再分发
        const normalized = this.reasoningNormalizer.normalize(
          provider,
          chunk as unknown as Record<string, unknown>,
        );

        // reasoning 和 content 可能同时存在于一个 chunk 中，需分别推送
        if (normalized.reasoning && includeReasoning) {
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

      // 流消费完毕，发送 DONE 信号并关闭 Subject，触发 SSE 连接结束
      subject.next({ type: StreamChunkType.DONE });
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

  /**
   * 提取 Token 使用统计
   *
   * 优先读取 LangChain 跨厂商标准化的 usage_metadata 字段，
   * 若不存在则回退到 response_metadata.tokenUsage（部分厂商的非标准路径）。
   * usage_metadata 由各 LangChain Provider 包内部归一化填充，结构稳定。
   */
  private extractTokenUsage(
    result: AIMessageChunk,
  ): ChatResponseDto['usage'] | undefined {
    // LangChain 标准化字段（推荐路径）
    const usageMeta = result.usage_metadata;
    if (usageMeta) {
      return {
        promptTokens: usageMeta.input_tokens ?? 0,
        completionTokens: usageMeta.output_tokens ?? 0,
        totalTokens: usageMeta.total_tokens ?? 0,
      };
    }

    // 兜底：部分 Provider 仅在 response_metadata 中填充 token 统计
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

  /**
   * 从 AIMessage 的 response_metadata 中提取完成原因
   */
  private extractFinishReason(result: AIMessageChunk): string | undefined {
    const metadata = result.response_metadata as
      | Record<string, unknown>
      | undefined;
    if (!metadata) return undefined;

    const reason = metadata.finish_reason;
    return typeof reason === 'string' ? reason : undefined;
  }
}
