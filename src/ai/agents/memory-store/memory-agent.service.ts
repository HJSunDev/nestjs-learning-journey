import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AIMessage } from '@langchain/core/messages';

import type { BaseMessage } from '@langchain/core/messages';

import { AiModelFactory } from '../../factories/model.factory';
import { ToolRegistry } from '../../tools/tool.registry';
import { CheckpointService } from '../persistence/checkpoint.service';
import { LangChainTracer } from '../../observability';
import { convertToLangChainMessages } from '../../utils';

import { MemoryStoreService } from './memory-store.service';
import { LaneQueueService } from './lane-queue.service';
import { SkillLoaderService } from './skill-loader.service';
import {
  buildMemoryGraph,
  type MemoryGraphCompiled,
  type MemoryGraphContext,
} from '../single/memory-graph';
import type {
  MemoryAgentInvokeParams,
  MemoryAgentInvokeResult,
  TokenUsage,
} from './memory-store.types';

/**
 * 运行时图接口 — 桥接 LangGraph 泛型约束
 *
 * LangGraph 的泛型声明会把 configurable 约束到 contextSchema 类型，
 * 但 Durable Execution 需要额外传入 thread_id。
 * 此接口参照 react.service.ts 的 DurableRuntimeGraph 模式定义。
 */
interface MemoryGraphInvokeOptions {
  context: MemoryGraphContext;
  callbacks: LangChainTracer[];
  configurable: { thread_id: string };
}

interface MemoryGraphResult {
  messages: BaseMessage[];
  memoriesLoaded: number;
  skillsLoaded: number;
  memoriesStored: number;
}

interface MemoryRuntimeGraph {
  invoke(
    input: { messages: BaseMessage[] },
    options: MemoryGraphInvokeOptions,
  ): Promise<MemoryGraphResult>;
}

/**
 * Memory-aware Agent 服务 — 052 章节的核心编排层
 *
 * 职责：
 * 1. 编译和缓存 Memory Graph（含 Store + Checkpointer）
 * 2. 处理 invoke 请求：组装 context、执行图、提取结果
 * 3. 通过 LaneQueueService 确保同一线程的请求串行执行
 *
 * 设计决策：
 * - 图在首次调用时延迟编译（确保 Store 和 Checkpointer 已初始化）
 * - 每次 invoke 通过 context 注入不同的模型实例和参数（图结构复用）
 * - Lane Queue 防止同一 threadId 的并发 checkpoint 写入冲突
 */
@Injectable()
export class MemoryAgentService {
  private readonly logger = new Logger(MemoryAgentService.name);

  private compiledGraph?: MemoryGraphCompiled;

  constructor(
    private readonly modelFactory: AiModelFactory,
    private readonly toolRegistry: ToolRegistry,
    private readonly configService: ConfigService,
    private readonly memoryStoreService: MemoryStoreService,
    private readonly checkpointService: CheckpointService,
    private readonly laneQueueService: LaneQueueService,
    private readonly skillLoaderService: SkillLoaderService,
  ) {}

  /**
   * 执行 Memory-aware Agent（非流式）
   *
   * 完整流程：
   * 1. 通过 LaneQueue 串行化同一 threadId 的请求
   * 2. loadMemories：从 Store 搜索相关记忆，动态构建系统提示词
   * 3. callModel：调用 LLM，如有 tool_calls 则进入工具循环
   * 4. extractMemories：从 AI 回复中提取新记忆并写入 Store
   * 5. 返回清理后的内容和记忆统计
   *
   * @param params - 调用参数
   * @param threadId - 可选线程 ID（用于 checkpoint 持久化和 Lane Queue 串行化）
   * @returns Memory Agent 调用结果
   */
  async invoke(
    params: MemoryAgentInvokeParams,
    threadId?: string,
  ): Promise<MemoryAgentInvokeResult> {
    const effectiveThreadId = threadId ?? crypto.randomUUID();

    // 通过 Lane Queue 串行化同一 thread 的请求
    return this.laneQueueService.enqueue(effectiveThreadId, () =>
      this.executeInvoke(params, effectiveThreadId),
    );
  }

  /**
   * 实际执行 invoke 逻辑（由 LaneQueue 保证串行）
   */
  private async executeInvoke(
    params: MemoryAgentInvokeParams,
    threadId: string,
  ): Promise<MemoryAgentInvokeResult> {
    const tracer = new LangChainTracer(this.logger);

    this.logger.log(
      `[MemoryAgent] 执行对话，提供商: ${params.provider}, 模型: ${params.model}, ` +
        `用户: ${params.userId}, 线程: ${threadId}, traceId: ${tracer.getTraceId()}`,
    );

    const model = this.modelFactory.createChatModel(params.provider, {
      model: params.model,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
    });

    const tools = params.toolNames
      ? this.toolRegistry.getTools(params.toolNames)
      : [];

    // 技能加载启用时，注入 load_skill / read_skill_file 工具 + 技能目录
    const enableSkills = params.enableSkillLoading ?? false;
    let skillCatalog = '';

    if (enableSkills) {
      const skillTools = this.skillLoaderService.createSkillTools();
      tools.push(...skillTools);
      skillCatalog = await this.skillLoaderService.getSkillCatalog();
    }

    const context: MemoryGraphContext = {
      model,
      tools,
      maxIterations: params.maxIterations ?? 5,
      userId: params.userId,
      systemPrompt: params.systemPrompt ?? '',
      enableMemoryExtraction: params.enableMemoryExtraction ?? true,
      enableSkillLoading: enableSkills,
      skillCatalog,
    };

    const messages = convertToLangChainMessages(params.messages);
    const graph = this.getCompiledGraph();

    const result = await graph.invoke(
      { messages },
      {
        context,
        configurable: { thread_id: threadId },
        callbacks: [tracer],
      },
    );

    const traceSummary = tracer.logSummary();

    // 提取最终 AIMessage
    const lastAiMessage = [...result.messages]
      .reverse()
      .find((m: { _getType: () => string }) => m._getType() === 'ai');

    const content = lastAiMessage
      ? typeof lastAiMessage.content === 'string'
        ? lastAiMessage.content
        : JSON.stringify(lastAiMessage.content)
      : '';

    return {
      content,
      memoriesLoaded: result.memoriesLoaded ?? 0,
      skillsLoaded: result.skillsLoaded ?? 0,
      memoriesStored: result.memoriesStored ?? 0,
      usage: this.extractUsage(lastAiMessage as AIMessage | undefined),
      trace: {
        traceId: traceSummary.traceId,
        totalLatencyMs: traceSummary.totalLatencyMs,
        llmCallCount: traceSummary.llmCallCount,
        totalTokens: traceSummary.totalTokenUsage.total,
      },
    };
  }

  /**
   * 获取编译后的 Memory Graph（延迟编译 + 缓存 + 类型桥接）
   *
   * 延迟编译的原因：Store 和 Checkpointer 在 onModuleInit 中初始化，
   * 首次调用时它们已经就绪。
   *
   * 类型桥接参照 react.service.ts 的 DurableRuntimeGraph 模式：
   * LangGraph 的泛型会把 configurable 约束到 contextSchema，
   * 但我们需要额外传入 thread_id，因此通过 MemoryRuntimeGraph 接口桥接。
   */
  private getCompiledGraph(): MemoryRuntimeGraph {
    if (!this.compiledGraph) {
      const store = this.memoryStoreService.getStore();
      const checkpointer = this.checkpointService.getCheckpointer();

      this.compiledGraph = buildMemoryGraph({
        store,
        checkpointer,
      });

      this.logger.log('MemoryGraph 已编译完成');
    }
    return this.compiledGraph as unknown as MemoryRuntimeGraph;
  }

  /**
   * 从 AIMessage 中提取 token 使用统计
   */
  private extractUsage(message?: AIMessage): TokenUsage | undefined {
    const usageMeta = message?.usage_metadata;
    if (usageMeta) {
      return {
        promptTokens: usageMeta.input_tokens ?? 0,
        completionTokens: usageMeta.output_tokens ?? 0,
        totalTokens: usageMeta.total_tokens ?? 0,
      };
    }
    return undefined;
  }
}
