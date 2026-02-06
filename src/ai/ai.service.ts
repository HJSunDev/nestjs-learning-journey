import { Injectable, Logger } from '@nestjs/common';
import { AiModelFactory } from './factories/model.factory';
import { ReasoningNormalizer } from './normalizers/reasoning.normalizer';
import { MessageRole } from './constants';
import {
  ChatRequestDto,
  QuickChatRequestDto,
  ChatResponseDto,
  ReasoningResponseDto,
} from './dto';
import { Observable, Subject } from 'rxjs';
import { StreamChunk } from './interfaces';
import { StreamChunkType } from './constants';

/**
 * AI 服务层
 *
 * 负责处理 AI 对话的核心业务逻辑：
 * 1. 调度 AiModelFactory 获取模型实例
 * 2. 通过 ReasoningNormalizer 归一化推理字段
 * 3. 将 LangChain 的流转换为前端可消费的 SSE 格式
 *
 * 安装 LangChain 依赖后，将 mock 替换为真实调用：
 * - 非流式：model.invoke(messages) → ReasoningNormalizer.normalize()
 * - 流式：  model.stream(messages) → for each chunk: normalize → Subject.next()
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly modelFactory: AiModelFactory,
    private readonly reasoningNormalizer: ReasoningNormalizer,
  ) {}

  /**
   * 标准对话（非流式）
   *
   * 适用于无需实时反馈的场景，如后台任务或简单的问答。
   *
   * @param dto 对话请求参数
   * @returns 完整的对话响应
   */
  async chat(dto: ChatRequestDto): Promise<ChatResponseDto> {
    const model = this.modelFactory.createChatModel(dto.provider, {
      model: dto.model,
      temperature: dto.temperature,
    });

    this.logger.log(`调用聊天接口，提供商: ${dto.provider}`);

    // TODO: 真实调用（安装 LangChain 后启用）
    // const result = await model.invoke(dto.messages);
    // const normalized = this.reasoningNormalizer.normalize(dto.provider, result);
    // return {
    //   content: normalized.content,
    //   reasoning: normalized.reasoning ?? undefined,
    // };

    // 模拟响应
    return {
      content: `[模拟] 来自 ${dto.provider} 的回复`,
      usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
    };
  }

  /**
   * 快速对话（单轮）
   *
   * 简化的调用方式，适合简单的单次交互。
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
   * 处理支持思维链（Chain of Thought）的模型，返回结果中包含推理过程。
   * ReasoningNormalizer 负责从模型输出中提取推理字段，调用方无需关心字段位置差异。
   *
   * @param dto 对话请求参数
   * @returns 包含推理过程的响应
   */
  async reasoningChat(dto: ChatRequestDto): Promise<ReasoningResponseDto> {
    const model = this.modelFactory.createChatModel(dto.provider, {
      model: dto.model,
      temperature: dto.temperature,
    });

    this.logger.log(`调用推理聊天接口，提供商: ${dto.provider}`);

    // TODO: 真实调用（安装 LangChain 后启用）
    // const result = await model.invoke(dto.messages);
    // const normalized = this.reasoningNormalizer.normalize(dto.provider, result);
    // return {
    //   content: normalized.content,
    //   reasoning: normalized.reasoning ?? '模型未返回推理过程',
    // };

    // 模拟带推理的响应
    return {
      content: `[模拟] 来自 ${dto.provider} 的最终答案`,
      reasoning: `[模拟] 思维链过程...\n步骤 1: 分析问题...\n步骤 2: 得出结论...`,
      usage: { totalTokens: 0, promptTokens: 0, completionTokens: 0 },
    };
  }

  /**
   * 流式对话
   *
   * 使用 LangChain 模型进行流式生成，并将其转换为 RxJS Observable 以适配 NestJS 的 SSE。
   *
   * @param dto 对话请求参数
   * @returns StreamChunk 的 Observable 流
   */
  streamChat(dto: ChatRequestDto): Observable<StreamChunk> {
    const subject = new Subject<StreamChunk>();
    const model = this.modelFactory.createChatModel(dto.provider, {
      model: dto.model,
      streaming: true,
    });

    this.logger.log(`开始流式对话，提供商: ${dto.provider}`);

    // 异步执行流处理，不阻塞主线程
    this.executeStream(model, dto.provider, dto.messages, subject);

    return subject.asObservable();
  }

  /**
   * 流式推理对话
   *
   * 类似 streamChat，但会通过 ReasoningNormalizer 区分推理块和文本块。
   *
   * @param dto 对话请求参数
   * @returns StreamChunk 的 Observable 流
   */
  streamReasoningChat(dto: ChatRequestDto): Observable<StreamChunk> {
    const subject = new Subject<StreamChunk>();
    const model = this.modelFactory.createChatModel(dto.provider, {
      model: dto.model,
      streaming: true,
    });

    this.logger.log(`开始流式推理对话，提供商: ${dto.provider}`);

    this.executeStream(model, dto.provider, dto.messages, subject, true);

    return subject.asObservable();
  }

  /**
   * 内部方法：处理 LangChain 流并推送到 RxJS Subject
   *
   * 安装 LangChain 后，此方法的核心逻辑为：
   * ```
   * const stream = await model.stream(messages);
   * for await (const chunk of stream) {
   *   const normalized = this.reasoningNormalizer.normalize(provider, chunk);
   *   if (normalized.reasoning) {
   *     subject.next({ type: StreamChunkType.REASONING, content: normalized.reasoning });
   *   }
   *   if (normalized.content) {
   *     subject.next({ type: StreamChunkType.TEXT, content: normalized.content });
   *   }
   * }
   * ```
   *
   * @param model             LangChain 模型实例
   * @param provider          厂商标识（用于推理字段归一化）
   * @param messages          消息历史
   * @param subject           RxJS Subject
   * @param includeReasoning  是否包含推理过程
   */
  private async executeStream(
    model: any,
    provider: string,
    messages: any[],
    subject: Subject<StreamChunk>,
    includeReasoning = false,
  ) {
    try {
      // TODO: 真实调用（安装 LangChain 后启用）
      // const stream = await model.stream(messages);
      // for await (const chunk of stream) {
      //   const normalized = this.reasoningNormalizer.normalize(provider, chunk);
      //   if (normalized.reasoning && includeReasoning) {
      //     subject.next({ type: StreamChunkType.REASONING, content: normalized.reasoning });
      //   }
      //   if (normalized.content) {
      //     subject.next({ type: StreamChunkType.TEXT, content: normalized.content });
      //   }
      // }

      // 模拟 LangChain 的异步迭代器行为
      const mockChunks = [
        { content: '', additional_kwargs: { reasoning_content: '正在思考第 1 步...' } },
        { content: '', additional_kwargs: { reasoning_content: '正在思考第 2 步...' } },
        { content: '你好', additional_kwargs: {} },
        { content: '，', additional_kwargs: {} },
        { content: '世界', additional_kwargs: {} },
        { content: '！', additional_kwargs: {} },
      ];

      for (const mockChunk of mockChunks) {
        // 通过 ReasoningNormalizer 归一化，与真实逻辑完全一致
        const normalized = this.reasoningNormalizer.normalize(
          provider,
          mockChunk,
        );

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

        // 模拟网络延迟
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      subject.next({ type: StreamChunkType.DONE });
      subject.complete();
    } catch (error) {
      this.logger.error('流式处理发生错误', error);
      subject.next({
        type: StreamChunkType.ERROR,
        error: error instanceof Error ? error.message : String(error),
      });
      subject.error(error);
    }
  }
}
