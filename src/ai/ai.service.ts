import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, Subject } from 'rxjs';

import { ToolRegistry } from './tools';
import {
  StreamChunk,
  GenerateOptions,
  GenerateResult,
  IAiProvider,
  Message,
} from './interfaces';
import { StreamChunkType, AiProvider, MessageRole } from './constants';
import {
  ChatRequestDto,
  QuickChatRequestDto,
  ChatResponseDto,
  ReasoningResponseDto,
} from './dto';

/**
 * AI 服务层
 *
 * 职责：
 * - 业务场景编排（对话、推理、工具调用等）
 * - Provider 调度（根据请求选择合适的 Provider）
 * - 流式输出转换（统一为 RxJS Observable）
 * - 错误处理与日志记录
 *
 * 设计说明：
 * - 当前版本为 NestJS 侧的框架实现，Provider 实际调用待 AI SDK 集成后补充
 * - 使用 Observable 作为流式输出的统一抽象，便于与 NestJS 生态集成
 */
@Injectable()
export class AiService implements OnModuleInit {
  private readonly logger = new Logger(AiService.name);

  /**
   * Provider 实例缓存
   * Key: AiProvider 枚举值
   * Value: IAiProvider 实例
   */
  private readonly providers = new Map<string, IAiProvider>();

  constructor(
    private readonly configService: ConfigService,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  onModuleInit() {
    this.logger.log('AI Service 初始化完成');
    this.logConfig();
  }

  /**
   * 记录当前配置信息
   */
  private logConfig(): void {
    const defaultProvider =
      this.configService.get<string>('ai.defaultProvider');
    this.logger.log(`默认 Provider: ${defaultProvider || '未配置'}`);
    this.logger.log(`已注册工具数: ${this.toolRegistry.size}`);
  }

  // ============================================================
  // 公开 API：业务场景方法
  // ============================================================

  /**
   * 场景一：标准对话（非流式）
   *
   * 适用于需要完整响应的场景
   */
  async chat(dto: ChatRequestDto): Promise<ChatResponseDto> {
    this.logger.debug(`对话请求: provider=${dto.provider}, model=${dto.model}`);

    const options = this.buildGenerateOptions(dto);
    const result = await this.generate(dto.provider, options);

    return {
      content: result.content,
      reasoning: result.reasoning,
      toolCalls: result.toolCalls,
      usage: result.usage,
      finishReason: result.finishReason,
    };
  }

  /**
   * 场景二：快速对话（单轮，非流式）
   *
   * 简化的单轮对话接口
   */
  async quickChat(dto: QuickChatRequestDto): Promise<ChatResponseDto> {
    const chatDto: ChatRequestDto = {
      provider: dto.provider,
      model: dto.model,
      messages: [{ role: MessageRole.USER, content: dto.prompt }],
      systemPrompt: dto.systemPrompt,
      temperature: dto.temperature,
    };
    return this.chat(chatDto);
  }

  /**
   * 场景三：流式对话
   *
   * 返回 RxJS Observable，可被 Controller 订阅并转为 SSE 响应
   */
  streamChat(dto: ChatRequestDto): Observable<StreamChunk> {
    this.logger.debug(
      `流式对话请求: provider=${dto.provider}, model=${dto.model}`,
    );

    const options = this.buildGenerateOptions(dto);
    return this.streamGenerate(dto.provider, options);
  }

  /**
   * 场景四：推理对话（含思考过程）
   *
   * 自动启用推理模式，返回完整的思考过程
   */
  async reasoningChat(dto: ChatRequestDto): Promise<ReasoningResponseDto> {
    this.logger.debug(
      `推理对话请求: provider=${dto.provider}, model=${dto.model}`,
    );

    const options = this.buildGenerateOptions({
      ...dto,
      enableReasoning: true,
    });
    const result = await this.generate(dto.provider, options);

    return {
      content: result.content,
      reasoning: result.reasoning || '',
      toolCalls: result.toolCalls,
      usage: result.usage,
      finishReason: result.finishReason,
    };
  }

  /**
   * 场景五：流式推理对话
   *
   * 流式返回思考过程和最终回答
   */
  streamReasoningChat(dto: ChatRequestDto): Observable<StreamChunk> {
    const options = this.buildGenerateOptions({
      ...dto,
      enableReasoning: true,
    });
    return this.streamGenerate(dto.provider, options);
  }

  /**
   * 场景六：带工具调用的对话
   *
   * AI 可调用注册的工具，工具执行结果会返回给 AI 继续推理
   */
  async chatWithTools(
    dto: ChatRequestDto,
    toolNames: string[],
  ): Promise<ChatResponseDto> {
    this.logger.debug(`工具对话请求: tools=${toolNames.join(',')}`);

    const options = this.buildGenerateOptions({
      ...dto,
      tools: toolNames,
    });

    // 工具调用循环逻辑（待 AI SDK 集成后实现）
    const result = await this.generate(dto.provider, options);

    return {
      content: result.content,
      reasoning: result.reasoning,
      toolCalls: result.toolCalls,
      usage: result.usage,
      finishReason: result.finishReason,
    };
  }

  // ============================================================
  // 核心生成方法
  // ============================================================

  /**
   * 非流式生成（核心）
   *
   * 调用 Provider 的 generateText 方法
   * 当前为 Mock 实现，待 AI SDK 集成后替换
   */
  private async generate(
    providerId: AiProvider,
    options: GenerateOptions,
  ): Promise<GenerateResult> {
    // TODO: 获取真实 Provider 并调用
    // const provider = this.getProvider(providerId);
    // return provider.generateText(options);

    // Mock 实现：模拟 AI 响应
    this.logger.debug('使用 Mock 生成（待集成 AI SDK）');

    await this.simulateDelay(500);

    return {
      content: `[Mock 响应] 收到 ${options.messages.length} 条消息，使用模型 ${options.model}`,
      reasoning: options.enableReasoning
        ? '[Mock 推理过程] 正在分析用户的问题...'
        : undefined,
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      },
      finishReason: 'stop',
    };
  }

  /**
   * 流式生成（核心）
   *
   * 返回 Observable<StreamChunk>
   * 当前为 Mock 实现，演示流式输出结构
   */
  private streamGenerate(
    providerId: AiProvider,
    options: GenerateOptions,
  ): Observable<StreamChunk> {
    // TODO: 获取真实 Provider 并调用
    // const provider = this.getProvider(providerId);
    // return provider.streamText(options);

    // Mock 实现：模拟流式输出
    this.logger.debug('使用 Mock 流式生成（待集成 AI SDK）');

    const subject = new Subject<StreamChunk>();

    // 异步模拟流式输出（使用 void 标记忽略 floating promise）
    void this.simulateMockStream(subject, options);

    return subject.asObservable();
  }

  /**
   * 模拟流式输出（Mock）
   */
  private async simulateMockStream(
    subject: Subject<StreamChunk>,
    options: GenerateOptions,
  ): Promise<void> {
    try {
      // 模拟推理过程
      if (options.enableReasoning) {
        const reasoningParts = [
          '让我思考一下这个问题...',
          '首先，我需要理解用户的意图。',
          '然后，我会组织答案的结构。',
        ];
        for (const part of reasoningParts) {
          await this.simulateDelay(100);
          subject.next({
            type: StreamChunkType.REASONING,
            content: part,
          });
        }
      }

      // 模拟正式回答
      const textParts = [
        '[Mock 流式响应] ',
        '这是模拟的流式输出，',
        `使用模型 ${options.model}。`,
        '待集成 AI SDK 后将替换为真实响应。',
      ];
      for (const part of textParts) {
        await this.simulateDelay(100);
        subject.next({
          type: StreamChunkType.TEXT,
          content: part,
        });
      }

      // 完成标记
      subject.next({ type: StreamChunkType.DONE });
      subject.complete();
    } catch (error) {
      subject.next({
        type: StreamChunkType.ERROR,
        error: error instanceof Error ? error.message : '未知错误',
      });
      subject.error(error);
    }
  }

  // ============================================================
  // 辅助方法
  // ============================================================

  /**
   * 构建生成选项
   */
  private buildGenerateOptions(dto: ChatRequestDto): GenerateOptions {
    const messages: Message[] = dto.messages.map((m) => ({
      role: m.role,
      content: m.content,
      toolCallId: m.toolCallId,
    }));

    return {
      model: dto.model,
      messages,
      systemPrompt: dto.systemPrompt,
      temperature: dto.temperature ?? this.getDefaultTemperature(),
      maxTokens: dto.maxTokens ?? this.getDefaultMaxTokens(),
      enableReasoning: dto.enableReasoning ?? false,
      tools: dto.tools,
    };
  }

  /**
   * 获取默认温度参数
   */
  private getDefaultTemperature(): number {
    return this.configService.get<number>('ai.defaults.temperature') ?? 0.7;
  }

  /**
   * 获取默认最大 Token 数
   */
  private getDefaultMaxTokens(): number {
    return this.configService.get<number>('ai.defaults.maxTokens') ?? 4096;
  }

  /**
   * 模拟延迟（Mock 使用）
   */
  private simulateDelay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 获取 Provider 实例
   * 待 AI SDK 集成后实现
   */
  // private getProvider(providerId: AiProvider): IAiProvider {
  //   const provider = this.providers.get(providerId);
  //   if (!provider) {
  //     throw new Error(`Provider "${providerId}" 未注册`);
  //   }
  //   return provider;
  // }

  /**
   * 注册 Provider
   * 待 AI SDK 集成后使用
   */
  registerProvider(provider: IAiProvider): void {
    this.providers.set(provider.providerId, provider);
    this.logger.log(`Provider 注册成功: ${provider.providerId}`);
  }
}
