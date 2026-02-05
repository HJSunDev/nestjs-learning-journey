import { Injectable, Logger } from '@nestjs/common';
import { AiModelFactory } from './factories/model.factory';
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

// LangChain 结构的模拟类型
type BaseChatModel = any;

/**
 * AI 服务层
 *
 * 负责处理 AI 对话的核心业务逻辑：
 * 1. 也是核心编排层，负责调度不同的 AI 模型工厂
 * 2. 统一处理流式响应，将 LangChain 的流转换为前端可消费的 SSE 格式
 * 3. 未来扩展：Agent 编排、工具调用管理、记忆管理
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(private readonly modelFactory: AiModelFactory) {}

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
    });

    // TODO: 真实调用: await model.invoke(dto.messages);
    this.logger.log(`调用聊天接口，提供商: ${dto.provider}`);

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
    // 转换为标准 ChatRequestDto
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
   * 专门处理支持思维链（Chain of Thought）的模型，返回结果中包含推理过程。
   *
   * @param dto 对话请求参数
   * @returns 包含推理过程的响应
   */
  async reasoningChat(dto: ChatRequestDto): Promise<ReasoningResponseDto> {
    const model = this.modelFactory.createChatModel(dto.provider, {
      model: dto.model,
    });

    this.logger.log(`调用推理聊天接口，提供商: ${dto.provider}`);

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
    this.executeStream(model, dto.messages, subject);

    return subject.asObservable();
  }

  /**
   * 流式推理对话
   *
   * 类似 streamChat，但会明确包含推理类型的块。
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

    this.executeStream(model, dto.messages, subject, true);

    return subject.asObservable();
  }

  /**
   * 内部方法：处理 LangChain 流并推送到 RxJS Subject
   *
   * @param model LangChain 模型实例
   * @param messages 消息历史
   * @param subject RxJS Subject
   * @param includeReasoning 是否包含推理过程
   */
  private async executeStream(
    model: BaseChatModel,
    messages: any[],
    subject: Subject<StreamChunk>,
    includeReasoning = false,
  ) {
    try {
      // TODO: 真实调用: const stream = await model.stream(messages);
      // 模拟 LangChain 的异步迭代器行为
      const mockStream = [
        { type: 'reasoning', content: '正在思考第 1 步...' },
        { type: 'reasoning', content: '正在思考第 2 步...' },
        { type: 'text', content: '你好' },
        { type: 'text', content: '，' },
        { type: 'text', content: '世界' },
        { type: 'text', content: '！' },
      ];

      for (const chunk of mockStream) {
        if (chunk.type === 'reasoning') {
          if (includeReasoning) {
            subject.next({
              type: StreamChunkType.REASONING,
              content: chunk.content,
            });
          }
        } else {
          subject.next({
            type: StreamChunkType.TEXT,
            content: chunk.content,
          });
        }

        // 模拟网络延迟
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // 发送完成信号（可选，SSE 通常由客户端判断连接关闭，但发送明确的 DONE 信号更规范）
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
