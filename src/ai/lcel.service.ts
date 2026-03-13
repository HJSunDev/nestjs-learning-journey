import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import type { AIMessageChunk } from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import { RunnableWithMessageHistory } from '@langchain/core/runnables';
import { AiModelFactory } from './factories/model.factory';
import { ReasoningNormalizer } from './normalizers/reasoning.normalizer';
import { ChatChainBuilder } from './chains';
import { SchemaRegistry, type SchemaListItem } from './schemas';
import { ToolRegistry, type ToolListItem } from './tools/tool.registry';
import { ToolCallingLoop } from './tools/tool-calling.loop';
import { ChatHistoryFactory } from './memory';
import { SessionManagerService } from './memory';
import { AiProvider, ReasoningMode, StreamChunkType } from './constants';
import { MODEL_REGISTRY } from './constants/model-registry';
import {
  ChatRequestDto,
  QuickChatRequestDto,
  ChatResponseDto,
  ReasoningResponseDto,
  StructuredChatRequestDto,
  StructuredExtractRequestDto,
  StructuredResponseDto,
  ToolCallingChatRequestDto,
  ToolCallingResponseDto,
  MemoryChatRequestDto,
  MemoryChatResponseDto,
  SessionHistoryResponseDto,
  SessionListResponseDto,
  ClearSessionResponseDto,
} from './dto';
import { Observable, Subject } from 'rxjs';
import { StreamChunk } from './interfaces';

/**
 * LCEL 管道服务层
 *
 * 与 038 章节的 AiService 完全隔离，专门用于演示声明式 LCEL 管道架构。
 * 核心差异：
 * - 不再直接调用 model.invoke(messages)
 * - 委托 ChatChainBuilder 组装 prompt.pipe(model) 管道
 * - 将 executeStream 的输入从 BaseChatModel 提升为 Runnable 接口
 *
 * 042 章节扩展：
 * - 新增 structuredChat / structuredExtract 方法
 * - 通过 withStructuredOutput 让模型返回强类型 JSON 对象
 *
 * 043 章节扩展：
 * - 新增 toolChat / streamToolChat 方法
 * - 通过 ToolCallingLoop 实现 Agentic 工具调用循环
 *
 * 044 章节扩展：
 * - 新增 memoryChat / streamMemoryChat 方法
 * - 通过 RunnableWithMessageHistory + Redis 实现有状态多轮会话
 * - 新增 getSessionHistory / listSessions / clearSession 会话管理方法
 */
@Injectable()
export class LcelService {
  private readonly logger = new Logger(LcelService.name);

  constructor(
    private readonly modelFactory: AiModelFactory,
    private readonly reasoningNormalizer: ReasoningNormalizer,
    private readonly chainBuilder: ChatChainBuilder,
    private readonly schemaRegistry: SchemaRegistry,
    private readonly toolRegistry: ToolRegistry,
    private readonly toolCallingLoop: ToolCallingLoop,
    private readonly chatHistoryFactory: ChatHistoryFactory,
    private readonly sessionManager: SessionManagerService,
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
  // 042 结构化输出方法
  // ============================================================

  /**
   * 获取所有可用的结构化输出 Schema 列表
   *
   * @returns Schema 名称、描述和字段信息
   */
  getAvailableSchemas(): SchemaListItem[] {
    return this.schemaRegistry.listSchemas();
  }

  /**
   * 多轮对话 + 结构化输出
   *
   * 管道结构：prompt → model.withStructuredOutput(schema)
   *
   * withStructuredOutput 设置 includeRaw: true，
   * 返回 { raw: AIMessage, parsed: T }，同时获取结构化数据和 token usage。
   *
   * @param dto 结构化对话请求
   * @returns 包含结构化数据和元数据的响应
   */
  async structuredChat(
    dto: StructuredChatRequestDto,
  ): Promise<StructuredResponseDto> {
    this.logger.log(
      `[LCEL-Structured] 多轮结构化输出，Schema: ${dto.schemaName}, ` +
        `提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    this.validateStructuredOutputSupport(dto.provider, dto.model);

    const schema = this.schemaRegistry.getSchema(dto.schemaName);
    const model = this.modelFactory.createChatModel(dto.provider, {
      model: dto.model,
      temperature: dto.temperature ?? 0,
      maxTokens: dto.maxTokens,
    });

    const { chain, input } = this.chainBuilder.buildStructuredChatChain(
      model,
      schema,
      dto.messages,
      dto.systemPrompt,
    );

    const result = (await chain.invoke(input)) as {
      raw: AIMessageChunk;
      parsed: Record<string, unknown>;
    };

    this.guardParsedResult(result.parsed, dto.schemaName);

    return {
      schemaName: dto.schemaName,
      data: result.parsed,
      usage: this.extractTokenUsage(result.raw),
      finishReason: this.extractFinishReason(result.raw),
    };
  }

  /**
   * 单轮快速提取 + 结构化输出
   *
   * 适用于从一段文本中直接提取结构化信息的场景（如情感分析、实体提取）。
   *
   * @param dto 结构化提取请求
   * @returns 包含结构化数据和元数据的响应
   */
  async structuredExtract(
    dto: StructuredExtractRequestDto,
  ): Promise<StructuredResponseDto> {
    this.logger.log(
      `[LCEL-Structured] 快速提取，Schema: ${dto.schemaName}, ` +
        `提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    this.validateStructuredOutputSupport(dto.provider, dto.model);

    const schema = this.schemaRegistry.getSchema(dto.schemaName);
    const model = this.modelFactory.createChatModel(dto.provider, {
      model: dto.model,
      temperature: dto.temperature ?? 0,
    });

    const { chain, input } = this.chainBuilder.buildStructuredQuickChatChain(
      model,
      schema,
      dto.prompt,
      dto.systemPrompt,
    );

    const result = (await chain.invoke(input)) as {
      raw: AIMessageChunk;
      parsed: Record<string, unknown>;
    };

    this.guardParsedResult(result.parsed, dto.schemaName);

    return {
      schemaName: dto.schemaName,
      data: result.parsed,
      usage: this.extractTokenUsage(result.raw),
      finishReason: this.extractFinishReason(result.raw),
    };
  }

  /**
   * 校验模型是否支持结构化输出
   *
   * 从 MODEL_REGISTRY 中查找模型定义，依据 capabilities.toolCalls
   * 判断该模型是否支持 tool calling（withStructuredOutput 的默认底层机制）。
   *
   * 对于注册表中未声明的模型（如用户自定义模型），放行并记录警告——
   * 避免因注册表不全而误拦，真正不支持时由 LangChain 层抛出运行时错误。
   */
  private validateStructuredOutputSupport(
    provider: AiProvider,
    modelId: string,
  ): void {
    const modelDef = MODEL_REGISTRY.find(
      (m) => m.id === modelId && m.provider === provider,
    );

    if (!modelDef) {
      this.logger.warn(
        `模型 "${modelId}" 未在 MODEL_REGISTRY 中注册，跳过结构化输出能力预检`,
      );
      return;
    }

    if (!modelDef.capabilities.toolCalls) {
      throw new BadRequestException(
        `模型 "${modelDef.name}"（${modelId}）不支持 tool calling，` +
          '无法使用结构化输出（withStructuredOutput）。' +
          '请切换到支持 tool calling 的模型。',
      );
    }
  }

  /**
   * 结构化输出结果兜底校验
   *
   * withStructuredOutput 内部已做 Zod parse，但某些边界情况（如模型返回空
   * tool_call、网络截断等）可能导致 parsed 为 null/undefined。
   * 此处作为最后一道防线，确保不会将无效数据静默返回给客户端。
   */
  private guardParsedResult(
    parsed: Record<string, unknown> | null | undefined,
    schemaName: string,
  ): asserts parsed is Record<string, unknown> {
    if (!parsed || typeof parsed !== 'object') {
      throw new BadRequestException(
        `结构化输出解析失败（Schema: ${schemaName}）。` +
          '模型未返回有效的结构化数据，可能原因：' +
          '模型不支持 tool calling、返回格式异常或网络中断。',
      );
    }
  }

  // ============================================================
  // 043 工具调用方法
  // ============================================================

  /**
   * 获取所有可用的工具列表
   *
   * @returns 工具名称和描述列表
   */
  getAvailableTools(): ToolListItem[] {
    return this.toolRegistry.listTools();
  }

  /**
   * 工具调用对话（非流式）
   *
   * 核心流程：
   * 1. 创建模型 → 2. 委托 ToolCallingLoop 执行工具调用循环
   * → 3. 返回最终文本响应 + 工具调用历史
   *
   * ToolCallingLoop 内部：
   * model.bindTools(tools) → invoke → 检查 tool_calls
   * → 有则执行工具、追加 ToolMessage、再次 invoke → 循环直到无 tool_calls
   *
   * @param dto 工具调用对话请求
   * @returns 包含最终文本和工具调用历史的响应
   */
  async toolChat(
    dto: ToolCallingChatRequestDto,
  ): Promise<ToolCallingResponseDto> {
    this.logger.log(
      `[LCEL-ToolCalling] 工具调用对话，提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    this.validateToolCallingSupport(dto.provider, dto.model);

    const model = this.modelFactory.createChatModel(dto.provider, {
      model: dto.model,
      temperature: dto.temperature,
      maxTokens: dto.maxTokens,
    });

    const result = await this.toolCallingLoop.execute({
      model,
      messages: dto.messages,
      systemPrompt: dto.systemPrompt,
      toolNames: dto.tools,
      maxIterations: dto.maxToolRounds,
    });

    return {
      content: result.content,
      rounds: result.rounds,
      totalRounds: result.totalRounds,
      usage: result.usage,
      finishReason: result.finishReason,
    };
  }

  /**
   * 流式工具调用对话
   *
   * 工具调用轮次通过 TOOL_CALL / TOOL_RESULT 事件实时推送，
   * 最终文本响应通过 TEXT 事件逐 chunk 输出。
   *
   * @param dto 工具调用对话请求
   * @returns StreamChunk 的 Observable 流
   */
  streamToolChat(dto: ToolCallingChatRequestDto): Observable<StreamChunk> {
    this.logger.log(
      `[LCEL-ToolCalling] 流式工具调用对话，提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    this.validateToolCallingSupport(dto.provider, dto.model);

    const model = this.modelFactory.createChatModel(dto.provider, {
      model: dto.model,
      streaming: true,
      temperature: dto.temperature,
      maxTokens: dto.maxTokens,
    });

    const subject = this.toolCallingLoop.streamExecute({
      model,
      messages: dto.messages,
      systemPrompt: dto.systemPrompt,
      toolNames: dto.tools,
      maxIterations: dto.maxToolRounds,
    });

    return subject.asObservable();
  }

  /**
   * 校验模型是否支持工具调用
   *
   * 工具调用（Tool Calling）要求模型支持 function calling 能力。
   * 对于注册表中未声明的模型，放行并记录警告。
   */
  private validateToolCallingSupport(
    provider: AiProvider,
    modelId: string,
  ): void {
    const modelDef = MODEL_REGISTRY.find(
      (m) => m.id === modelId && m.provider === provider,
    );

    if (!modelDef) {
      this.logger.warn(
        `模型 "${modelId}" 未在 MODEL_REGISTRY 中注册，跳过工具调用能力预检`,
      );
      return;
    }

    if (!modelDef.capabilities.toolCalls) {
      throw new BadRequestException(
        `模型 "${modelDef.name}"（${modelId}）不支持 tool calling，` +
          '无法使用工具调用功能。请切换到支持 tool calling 的模型。',
      );
    }
  }

  // ============================================================
  // 044 有状态会话（Memory）方法
  // ============================================================

  /**
   * 有状态会话对话（非流式）
   *
   * 核心流程：
   * 1. 构建 prompt → model 管道（带 history 占位符）
   * 2. 用 RunnableWithMessageHistory 包装，注入 Redis 历史管理
   * 3. invoke 时自动：加载历史 → 拼接输入 → 推理 → 持久化新消息
   *
   * @param dto 有状态会话请求
   * @returns 包含 sessionId 的对话响应
   */
  async memoryChat(dto: MemoryChatRequestDto): Promise<MemoryChatResponseDto> {
    this.logger.log(
      `[LCEL-Memory] 有状态对话，会话: ${dto.sessionId}, ` +
        `提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

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

    const chainWithHistory = this.buildMemoryChain(model, dto);
    const config = { configurable: { sessionId: dto.sessionId } };
    const result = (await chainWithHistory.invoke(
      { input: dto.input },
      config,
    )) as AIMessageChunk;

    const normalized = this.reasoningNormalizer.normalize(
      dto.provider,
      result as unknown as Record<string, unknown>,
    );

    return {
      sessionId: dto.sessionId,
      content: normalized.content,
      reasoning: normalized.reasoning ?? undefined,
      usage: this.extractTokenUsage(result),
      finishReason: this.extractFinishReason(result),
    };
  }

  /**
   * 有状态会话对话（流式）
   *
   * 与非流式版本共享同一条 RunnableWithMessageHistory 包装的链，
   * 区别在于调用 .stream() 而非 .invoke()。
   * 流结束后，RunnableWithMessageHistory 自动将完整响应持久化到 Redis。
   *
   * @param dto 有状态会话请求
   * @returns StreamChunk 的 Observable 流
   */
  streamMemoryChat(dto: MemoryChatRequestDto): Observable<StreamChunk> {
    this.logger.log(
      `[LCEL-Memory] 流式有状态对话，会话: ${dto.sessionId}, ` +
        `提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

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

    const chainWithHistory = this.buildMemoryChain(model, dto);
    const config = { configurable: { sessionId: dto.sessionId } };
    const subject = new Subject<StreamChunk>();

    void this.executeStream(
      chainWithHistory,
      dto.provider,
      { input: dto.input },
      subject,
      config,
    );

    return subject.asObservable();
  }

  /**
   * 获取指定会话的历史消息
   */
  async getSessionHistory(
    sessionId: string,
  ): Promise<SessionHistoryResponseDto> {
    const [messages, info] = await Promise.all([
      this.sessionManager.getSessionMessages(sessionId),
      this.sessionManager.getSessionInfo(sessionId),
    ]);

    return {
      sessionId,
      messages,
      messageCount: info.messageCount,
      ttl: info.ttl,
    };
  }

  /**
   * 列出所有活跃会话
   */
  async listSessions(): Promise<SessionListResponseDto> {
    // listSessions方法列出所有活跃会话，返回会话列表和总数
    const sessions = await this.sessionManager.listSessions();
    return { sessions, total: sessions.length };
  }

  /**
   * 清除指定会话的全部历史
   */
  async clearSession(sessionId: string): Promise<ClearSessionResponseDto> {
    const { messageCount } = await this.sessionManager.clearSession(sessionId);
    return {
      sessionId,
      deletedMessageCount: messageCount,
      message: `会话 ${sessionId} 已清除，共删除 ${messageCount} 条消息`,
    };
  }

  /**
   * 构建被 RunnableWithMessageHistory 包装的链
   *
   * 将 ChatChainBuilder 产出的管道与 ChatHistoryFactory 组合，
   * 形成完整的有状态对话链。
   */
  private buildMemoryChain(
    model: ReturnType<AiModelFactory['createChatModel']>,
    dto: MemoryChatRequestDto,
  ) {
    const { chain, inputMessagesKey, historyMessagesKey } =
      this.chainBuilder.buildMemoryChatChain(model, dto.systemPrompt);

    return new RunnableWithMessageHistory({
      runnable: chain,
      getMessageHistory: (sessionId: string) =>
        this.chatHistoryFactory.create(sessionId, {
          ttl: dto.sessionTTL,
          windowSize: dto.maxHistoryLength,
        }),
      inputMessagesKey,
      historyMessagesKey,
    });
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
   * 044 扩展：新增可选 config 参数，供 RunnableWithMessageHistory 传入 sessionId。
   */
  private async executeStream(
    chain: Runnable,
    provider: string,
    chainInput: Record<string, unknown>,
    subject: Subject<StreamChunk>,
    config?: Record<string, unknown>,
  ) {
    try {
      const stream = await chain.stream(chainInput, config);

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
