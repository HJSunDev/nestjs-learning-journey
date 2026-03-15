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
import { VectorStoreService, DocumentProcessor } from './rag';
import { LangChainTracer } from './observability';
import { ResilienceService } from './resilience';
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
  IngestDocumentsRequestDto,
  IngestDocumentsResponseDto,
  RagChatRequestDto,
  RagChatResponseDto,
  RetrievedSourceDto,
  SimilaritySearchRequestDto,
  SimilaritySearchResponseDto,
  CollectionListResponseDto,
  DeleteCollectionResponseDto,
  ResilientChatRequestDto,
  ResilientChatResponseDto,
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
 *
 * 045 章节扩展：
 * - 新增 ingestDocuments / ragChat / streamRagChat / similaritySearch 方法
 * - 通过 PgVectorStore + OpenAIEmbeddings 实现检索增强生成
 * - 新增 listCollections / deleteCollection 集合管理方法
 *
 * 046 章节扩展：
 * - 新增 resilientChat / streamResilientChat 方法
 * - LangChainTracer 回调处理器：per-request 粒度的链路追踪
 * - ResilienceService：.withRetry() 重试 + .withFallbacks() 降级
 * - 追踪摘要（TraceSummary）随响应返回，提供结构化的可观测性指标
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
    private readonly vectorStoreService: VectorStoreService,
    private readonly documentProcessor: DocumentProcessor,
    private readonly resilienceService: ResilienceService,
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

  // ============================================================
  // 045 RAG 检索增强生成
  // ============================================================

  /**
   * 文档摄入：切块 → 向量化 → 存入 PGVector
   *
   * @param dto 摄入请求参数
   * @returns 摄入结果（文档块 ID 列表和统计信息）
   */
  async ingestDocuments(
    dto: IngestDocumentsRequestDto,
  ): Promise<IngestDocumentsResponseDto> {
    this.logger.log(
      `[RAG] 文档摄入，集合: ${dto.collection || 'default'}, 文档数: ${dto.documents.length}`,
    );

    const docs = await this.documentProcessor.splitMany(
      dto.documents.map((d) => ({ text: d.text, metadata: d.metadata })),
      { chunkSize: dto.chunkSize, chunkOverlap: dto.chunkOverlap },
    );

    const store = this.vectorStoreService.getStore();
    const collection = dto.collection || 'default';
    const ids = await store.addDocuments(docs, { collection });

    return {
      documentIds: ids,
      chunkCount: docs.length,
      collection,
      message: `成功摄入 ${dto.documents.length} 篇文档，生成 ${docs.length} 个文档块`,
    };
  }

  /**
   * RAG 对话：检索 → 拼接上下文 → LLM 生成
   *
   * 完整链路：
   * 1. 将用户问题向量化
   * 2. 从 PGVector 中检索 topK 个最相关的文档块
   * 3. 将文档块内容拼接为上下文，注入 RAG 提示词
   * 4. LLM 基于上下文生成回答
   *
   * @param dto RAG 对话请求
   * @returns 包含回答内容和来源文档的响应
   */
  async ragChat(dto: RagChatRequestDto): Promise<RagChatResponseDto> {
    this.logger.log(
      `[RAG] 对话，集合: ${dto.collection || 'default'}, ` +
        `提供商: ${dto.provider}, 模型: ${dto.model}`,
    );

    const { sources, context } = await this.retrieveContext(
      dto.question,
      dto.topK,
      dto.collection,
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

    const { chain, input } = this.chainBuilder.buildRagChain(
      model,
      dto.question,
      context,
      dto.systemPrompt,
    );

    const result = (await chain.invoke(input)) as AIMessageChunk;

    const normalized = this.reasoningNormalizer.normalize(
      dto.provider,
      result as unknown as Record<string, unknown>,
    );

    return {
      content: normalized.content || '',
      sources,
      reasoning: normalized.reasoning || undefined,
      usage: this.extractTokenUsage(result),
      finishReason: this.extractFinishReason(result),
    };
  }

  /**
   * 流式 RAG 对话
   *
   * 与 ragChat 相同的检索链路，区别在于 LLM 生成阶段使用 stream()。
   * 检索阶段仍然是同步完成的（需要先获取完整上下文才能开始生成）。
   *
   * @param dto RAG 对话请求
   * @returns StreamChunk 的 Observable 流
   */
  streamRagChat(dto: RagChatRequestDto): Observable<StreamChunk> {
    const subject = new Subject<StreamChunk>();

    void (async () => {
      try {
        const { sources, context } = await this.retrieveContext(
          dto.question,
          dto.topK,
          dto.collection,
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

        const { chain, input } = this.chainBuilder.buildRagChain(
          model,
          dto.question,
          context,
          dto.systemPrompt,
        );

        await this.executeStream(
          chain,
          dto.provider,
          input,
          subject,
          undefined,
          { sources },
        );
      } catch (error) {
        this.logger.error('[RAG] 流式对话发生错误', error);
        subject.next({
          type: StreamChunkType.ERROR,
          error: error instanceof Error ? error.message : String(error),
        });
        subject.complete();
      }
    })();

    return subject.asObservable();
  }

  /**
   * 相似度搜索（直接检索，不经过 LLM）
   *
   * 用于调试检索质量、浏览知识库内容。
   */
  async similaritySearch(
    dto: SimilaritySearchRequestDto,
  ): Promise<SimilaritySearchResponseDto> {
    this.logger.log(
      `[RAG] 相似度搜索，查询: "${dto.query}", topK: ${dto.topK || 4}`,
    );

    const store = this.vectorStoreService.getStore();
    const results = await store.similaritySearchWithScore(
      dto.query,
      dto.topK || 4,
      dto.collection ? { collection: dto.collection } : undefined,
    );

    return {
      results: results.map(([doc, score]) => ({
        content: doc.pageContent,
        score,
        metadata: doc.metadata,
      })),
      total: results.length,
    };
  }

  /**
   * 列出所有知识库集合
   */
  async listCollections(): Promise<CollectionListResponseDto> {
    const store = this.vectorStoreService.getStore();
    const collections = await store.listCollections();
    return { collections, total: collections.length };
  }

  /**
   * 删除指定集合的所有文档
   */
  async deleteCollection(
    collection: string,
  ): Promise<DeleteCollectionResponseDto> {
    const store = this.vectorStoreService.getStore();
    const deletedDocumentCount = await store.getDocumentCount(collection);
    await store.delete({ collection });
    return {
      collection,
      deletedDocumentCount,
      message: `集合 ${collection} 已清除，共删除 ${deletedDocumentCount} 个文档块`,
    };
  }

  /**
   * 从向量数据库检索相关文档并序列化为上下文文本
   *
   * 返回结构：
   * @property sources - 结构化的来源信息数组，用于 API 响应
   *   { content: string, score: number, metadata: Record<string, unknown> }
   * @property context - 序列化的上下文文本，用于注入 LLM prompt
   *   格式："[来源 1] (文件名)\n文档内容\n\n[来源 2] (文件名)\n文档内容"
   *
   * @example 返回值示例
   * {
   *   sources: [
   *     { content: "依赖注入是 NestJS 的核心特性...", score: 0.15, metadata: { source: "di.md" } },
   *     { content: "模块用于组织应用程序结构...", score: 0.23, metadata: { source: "module.md" } }
   *   ],
   *   context: "[来源 1] (di.md)\n依赖注入是 NestJS 的核心特性...\n\n[来源 2] (module.md)\n模块用于组织应用程序结构..."
   * }
   */
  private async retrieveContext(
    question: string,
    topK?: number,
    collection?: string,
  ): Promise<{ sources: RetrievedSourceDto[]; context: string }> {
    const store = this.vectorStoreService.getStore();
    const k = topK || 4;

    // 使用 similaritySearchWithScore 方法进行相似度搜索，返回结果为数组，单个数组元素为 [doc, score]
    const results = await store.similaritySearchWithScore(
      question,
      k,
      collection ? { collection } : undefined,
    );

    // 获取引用来源信息列表，将results转换为RetrievedSourceDto数组
    const sources: RetrievedSourceDto[] = results.map(([doc, score]) => ({
      content: doc.pageContent,
      score,
      metadata: doc.metadata,
    }));

    // 获取字符串类型的上下文文本，将结果转换为上下文文本，会注入到 LLM prompt 中
    const context = results
      .map(
        ([doc], i) =>
          `[来源 ${i + 1}]${doc.metadata?.source ? ` (${doc.metadata.source})` : ''}\n${doc.pageContent}`,
      )
      .join('\n\n');

    this.logger.debug(`[RAG] 检索完成，命中 ${results.length} 个文档块`);

    return { sources, context };
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
   * 045 扩展：新增可选 doneExtras 参数，作为流结束时元数据（如 RAG sources）的通用注入机制。
   * 046 扩展：新增可选 tracer 参数，在流结束时动态计算追踪摘要并注入 DONE 块。
   *          不能放在 doneExtras 中，因为 doneExtras 在流开始前传入，
   *          而追踪摘要必须在流结束后（所有 Span 收集完毕）才能计算。
   */
  private async executeStream(
    chain: Runnable,
    provider: string,
    chainInput: Record<string, unknown>,
    subject: Subject<StreamChunk>,
    config?: Record<string, unknown>,
    // 随 DONE 块下发的附加元数据（如 sources、usage 等），提供通用的流结束信息注入能力
    doneExtras?: Partial<Omit<StreamChunk, 'type'>>,
    // 可选的追踪器实例，流结束时自动调用 logSummary() 并将摘要注入 DONE 块
    tracer?: LangChainTracer,
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

      // 流结束后，所有回调（handleLLMEnd 等）已触发完毕，此时计算追踪摘要
      const doneChunk: StreamChunk = {
        type: StreamChunkType.DONE,
        usage,
        finishReason,
        ...doneExtras,
      };

      if (tracer) {
        const summary = tracer.logSummary();
        doneChunk.trace = {
          traceId: summary.traceId,
          totalLatencyMs: summary.totalLatencyMs,
          llmCallCount: summary.llmCallCount,
          llmTotalLatencyMs: summary.llmTotalLatencyMs,
          totalTokens: summary.totalTokenUsage.total,
        };
      }

      subject.next(doneChunk);
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

  // ============================================================
  // 046 可观测性与韧性 (Observability & Resilience)
  // ============================================================

  /**
   * 韧性对话（非流式）
   *
   * 完整链路：
   * 1. 创建 LangChainTracer（per-request 追踪回调）
   * 2. 构建 LCEL 管道（prompt → model）
   * 3. 通过 ResilienceService 叠加重试 + 降级策略
   * 4. 以 callbacks 方式注入 Tracer，自动传播到所有嵌套组件
   * 5. 返回对话结果 + 追踪摘要
   *
   * @param dto 韧性对话请求参数
   * @returns 包含对话内容和追踪摘要的响应
   */
  async resilientChat(
    dto: ResilientChatRequestDto,
  ): Promise<ResilientChatResponseDto> {
    const tracer = new LangChainTracer(this.logger);

    this.logger.log(
      `[LCEL-Resilient] 韧性对话，提供商: ${dto.provider}, 模型: ${dto.model}, ` +
        `traceId: ${tracer.getTraceId()}`,
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

    const { chain, input } = this.chainBuilder.buildChatChain(
      model,
      dto.messages,
      dto.systemPrompt,
    );

    // 叠加韧性策略
    let resilientChain: Runnable = chain;

    if (dto.enableRetry !== false) {
      resilientChain = this.resilienceService.withRetry(resilientChain, {
        maxAttempts: dto.maxRetryAttempts ?? 2,
      });
    }

    if (dto.fallbacks?.length) {
      const fallbackModels = this.resilienceService.createFallbackModels(
        dto.fallbacks.map((f) => ({
          provider: f.provider,
          model: f.model,
        })),
        { temperature: dto.temperature, maxTokens: dto.maxTokens },
      );

      // 为每个降级模型构建完整的 prompt → model 管道
      const fallbackChains = fallbackModels.map((fbModel) => {
        const { chain: fbChain } = this.chainBuilder.buildChatChain(
          fbModel,
          dto.messages,
          dto.systemPrompt,
        );
        // 降级链也应用重试
        return dto.enableRetry !== false
          ? this.resilienceService.withRetry(fbChain, {
              maxAttempts: dto.maxRetryAttempts ?? 2,
            })
          : fbChain;
      });

      if (fallbackChains.length > 0) {
        resilientChain = this.resilienceService.withFallbacks(
          resilientChain,
          fallbackChains,
        );
      }
    }

    // 通过 callbacks 注入 Tracer，LangChain 自动向下传播到 model 层
    const result = (await resilientChain.invoke(input, {
      callbacks: [tracer],
    })) as AIMessageChunk;

    const summary = tracer.logSummary();

    const normalized = this.reasoningNormalizer.normalize(
      dto.provider,
      result as unknown as Record<string, unknown>,
    );

    return {
      content: normalized.content,
      reasoning: normalized.reasoning ?? undefined,
      usage: this.extractTokenUsage(result),
      finishReason: this.extractFinishReason(result),
      trace: {
        traceId: summary.traceId,
        totalLatencyMs: summary.totalLatencyMs,
        llmCallCount: summary.llmCallCount,
        llmTotalLatencyMs: summary.llmTotalLatencyMs,
        totalTokens: summary.totalTokenUsage.total,
        toolCallCount: summary.toolCallCount || undefined,
        retrieverCallCount: summary.retrieverCallCount || undefined,
        retryTriggered: summary.llmCallCount > 1,
        fallbackTriggered: summary.hasError,
      },
    };
  }

  /**
   * 韧性对话（流式）
   *
   * 与非流式版本共享同一套韧性策略组装逻辑，
   * 区别在于使用 .stream() 而非 .invoke()。
   *
   * 注意：LangChain 的 .withFallbacks() 在流式模式下仅对流创建阶段的错误
   * 触发降级，流开始后的错误不会触发。这是框架层面的设计限制。
   *
   * @param dto 韧性对话请求参数
   * @returns StreamChunk 的 Observable 流
   */
  streamResilientChat(dto: ResilientChatRequestDto): Observable<StreamChunk> {
    const tracer = new LangChainTracer(this.logger);
    const subject = new Subject<StreamChunk>();

    this.logger.log(
      `[LCEL-Resilient] 流式韧性对话，提供商: ${dto.provider}, 模型: ${dto.model}, ` +
        `traceId: ${tracer.getTraceId()}`,
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

    const { chain, input } = this.chainBuilder.buildChatChain(
      model,
      dto.messages,
      dto.systemPrompt,
    );

    let resilientChain: Runnable = chain;

    if (dto.enableRetry !== false) {
      resilientChain = this.resilienceService.withRetry(resilientChain, {
        maxAttempts: dto.maxRetryAttempts ?? 2,
      });
    }

    if (dto.fallbacks?.length) {
      const fallbackModels = this.resilienceService.createFallbackModels(
        dto.fallbacks.map((f) => ({
          provider: f.provider,
          model: f.model,
        })),
        {
          temperature: dto.temperature,
          streaming: true,
          maxTokens: dto.maxTokens,
        },
      );

      const fallbackChains = fallbackModels.map((fbModel) => {
        const { chain: fbChain } = this.chainBuilder.buildChatChain(
          fbModel,
          dto.messages,
          dto.systemPrompt,
        );
        return dto.enableRetry !== false
          ? this.resilienceService.withRetry(fbChain, {
              maxAttempts: dto.maxRetryAttempts ?? 2,
            })
          : fbChain;
      });

      if (fallbackChains.length > 0) {
        resilientChain = this.resilienceService.withFallbacks(
          resilientChain,
          fallbackChains,
        );
      }
    }

    void this.executeStream(
      resilientChain,
      dto.provider,
      input,
      subject,
      { callbacks: [tracer] },
      undefined,
      tracer,
    );

    return subject.asObservable();
  }

  /**
   * 创建 LangChainTracer 实例（供其他模块或高级场景使用）
   *
   * 允许调用方获取独立的 Tracer 实例，手动传入 callbacks 实现自定义追踪。
   */
  createTracer(): LangChainTracer {
    return new LangChainTracer(this.logger);
  }
}
