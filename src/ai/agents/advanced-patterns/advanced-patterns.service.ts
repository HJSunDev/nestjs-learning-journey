import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AIMessage } from '@langchain/core/messages';

import { AiModelFactory } from '../../factories/model.factory';
import { ToolRegistry } from '../../tools/tool.registry';
import { LangChainTracer } from '../../observability';
import { AiProvider } from '../../constants';
import { MODEL_REGISTRY } from '../../constants/model-registry';
import type { Message } from '../../interfaces';
import { convertToLangChainMessages } from '../../utils';

import {
  buildReflectionGraph,
  type ReflectionGraphCompiled,
  type ReflectionGraphContext,
} from '../single/reflection-graph';
import {
  buildPlanExecuteGraph,
  type PlanExecuteGraphCompiled,
  type PlanExecuteGraphContext,
} from '../single/plan-execute-graph';
import type {
  ReflectionInvokeResult,
  PlanExecuteInvokeResult,
  TokenUsage,
} from './advanced-patterns.types';

/**
 * Reflection 调用参数
 */
export interface ReflectionInvokeParams {
  provider: string;
  model: string;
  messages: Message[];
  systemPrompt?: string;
  /** 评估标准（注入 Evaluator 提示词） */
  evaluationCriteria?: string;
  /** 最大反思次数（默认 3） */
  maxReflections?: number;
  temperature?: number;
  maxTokens?: number;
  /**
   * Evaluator 使用的模型（可选，默认使用同一模型）
   *
   * 生产场景下可让 Evaluator 使用更强的模型做质量把关
   */
  evaluatorModel?: string;
  evaluatorProvider?: string;
}

/**
 * Plan-Execute 调用参数
 */
export interface PlanExecuteInvokeParams {
  provider: string;
  model: string;
  messages: Message[];
  systemPrompt?: string;
  /** Executor 可用工具列表 */
  toolNames?: string[];
  /** Executor 子图最大迭代次数（默认 5） */
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
}

/**
 * 高级模式服务
 * Advanced Patterns Service — 高级 Agent 模式的 NestJS 桥接层
 *
 * 封装 051 章节的两种高级 Agent 模式：
 * 1. Reflection（自我修正）：生成 → 评估 → 修正循环
 * 2. Plan-Execute（规划执行）：规划 → 逐步执行 → 动态调整
 *
 * 设计决策：
 * - 图在每次调用时编译（因为 maxReflections 等参数影响 State 初始值）
 * - Reflection 支持 Generator/Evaluator 使用不同模型
 * - Plan-Execute 的 Executor 在节点内部调用 tool-graph 子图
 */
@Injectable()
export class AdvancedPatternsService {
  private readonly logger = new Logger(AdvancedPatternsService.name);

  /** 缓存无 checkpointer 的编译图（State 默认值不变时可复用） */
  private reflectionGraph?: ReflectionGraphCompiled;
  private planExecuteGraph?: PlanExecuteGraphCompiled;

  constructor(
    private readonly modelFactory: AiModelFactory,
    private readonly toolRegistry: ToolRegistry,
    private readonly configService: ConfigService,
  ) {}

  // ============================================================
  // Reflection 模式
  // ============================================================

  /**
   * 执行 Reflection 自我修正图（非流式）
   *
   * 完整流程：
   * 1. 创建 Generator 和 Evaluator 模型实例
   * 2. 构建 context（两个模型 + 评估标准 + 系统提示词）
   * 3. 执行 generate → evaluate → shouldReflect 循环
   * 4. 返回最终生成内容和评估元数据
   *
   * @param params - 调用参数（模型、消息、评估标准等）
   * @returns Reflection 调用结果
   */
  async invokeReflection(
    params: ReflectionInvokeParams,
  ): Promise<ReflectionInvokeResult> {
    const tracer = new LangChainTracer(this.logger);

    this.logger.log(
      `[Reflection] 执行自我修正，提供商: ${params.provider}, 模型: ${params.model}, ` +
        `最大反思次数: ${params.maxReflections ?? 3}, traceId: ${tracer.getTraceId()}`,
    );

    const generatorModel = this.modelFactory.createChatModel(params.provider, {
      model: params.model,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
    });

    // Evaluator 可使用不同的模型做质量把关
    const evaluatorModel = params.evaluatorModel
      ? this.modelFactory.createChatModel(
          params.evaluatorProvider ?? params.provider,
          {
            model: params.evaluatorModel,
            temperature: 0,
            maxTokens: params.maxTokens,
          },
        )
      : this.modelFactory.createChatModel(params.provider, {
          model: params.model,
          temperature: 0,
          maxTokens: params.maxTokens,
        });

    const context: ReflectionGraphContext = {
      generatorModel,
      evaluatorModel,
      generatorPrompt: params.systemPrompt ?? '',
      evaluationCriteria: params.evaluationCriteria ?? '',
    };

    const messages = convertToLangChainMessages(params.messages);

    const graph = this.getReflectionGraph();

    const result = await graph.invoke(
      {
        messages,
        maxReflections: params.maxReflections ?? 3,
      },
      {
        context,
        callbacks: [tracer],
      },
    );

    const traceSummary = tracer.logSummary();

    // 提取最终 AIMessage（最后一条 AI 类型消息）
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
      reflectionCount: result.reflectionCount ?? 0,
      score: result.lastScore,
      feedback: result.lastFeedback,
      passed: result.evaluationPassed ?? false,
      usage: this.extractUsage(lastAiMessage as AIMessage | undefined),
      trace: {
        traceId: traceSummary.traceId,
        totalLatencyMs: traceSummary.totalLatencyMs,
        llmCallCount: traceSummary.llmCallCount,
        totalTokens: traceSummary.totalTokenUsage.total,
      },
    };
  }

  // ============================================================
  // Plan-Execute 模式
  // ============================================================

  /**
   * 执行 Plan-and-Execute 图（非流式）
   *
   * 完整流程：
   * 1. Planner 将用户目标分解为步骤列表
   * 2. Executor 逐步执行（每步通过 tool-graph 子图使用工具）
   * 3. Replanner 审视进度，决定继续/调整/完成
   * 4. 返回最终汇总和各步骤结果
   *
   * @param params - 调用参数（模型、消息、工具列表等）
   * @returns Plan-Execute 调用结果
   */
  async invokePlanExecute(
    params: PlanExecuteInvokeParams,
  ): Promise<PlanExecuteInvokeResult> {
    this.validateToolCallingSupport(params.provider, params.model);

    const tracer = new LangChainTracer(this.logger);

    this.logger.log(
      `[PlanExecute] 执行规划-执行，提供商: ${params.provider}, 模型: ${params.model}, ` +
        `traceId: ${tracer.getTraceId()}`,
    );

    const plannerModel = this.modelFactory.createChatModel(params.provider, {
      model: params.model,
      temperature: params.temperature ?? 0.2,
      maxTokens: params.maxTokens,
    });

    const executorModel = this.modelFactory.createChatModel(params.provider, {
      model: params.model,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
    });

    const tools = this.toolRegistry.getTools(params.toolNames);

    const context: PlanExecuteGraphContext = {
      plannerModel,
      executorModel,
      tools,
      maxIterations: params.maxIterations ?? 5,
    };

    const messages = convertToLangChainMessages(
      params.messages,
      params.systemPrompt,
    );

    const graph = this.getPlanExecuteGraph();

    const result = await graph.invoke(
      { messages },
      {
        context,
        callbacks: [tracer],
      },
    );

    const traceSummary = tracer.logSummary();

    const content = result.finalResponse ?? '';

    return {
      content,
      plan: result.plan ?? [],
      stepResults: result.pastStepResults ?? [],
      usage: this.extractUsageFromMessages(result.messages),
      trace: {
        traceId: traceSummary.traceId,
        totalLatencyMs: traceSummary.totalLatencyMs,
        llmCallCount: traceSummary.llmCallCount,
        totalTokens: traceSummary.totalTokenUsage.total,
      },
    };
  }

  // ============================================================
  // 私有方法
  // ============================================================

  /**
   * 获取 Reflection 图
   */
  private getReflectionGraph(): ReflectionGraphCompiled {
    if (!this.reflectionGraph) {
      this.reflectionGraph = buildReflectionGraph();
      this.logger.log('ReflectionGraph 已编译完成');
    }
    return this.reflectionGraph;
  }

  /**
   * 获取 Plan-Execute 图
   */
  private getPlanExecuteGraph(): PlanExecuteGraphCompiled {
    if (!this.planExecuteGraph) {
      this.planExecuteGraph = buildPlanExecuteGraph();
      this.logger.log('PlanExecuteGraph 已编译完成');
    }
    return this.planExecuteGraph;
  }

  /**
   * 校验模型是否支持工具调用
   */
  private validateToolCallingSupport(provider: string, modelId: string): void {
    const modelDef = MODEL_REGISTRY.find(
      (m) => m.id === modelId && m.provider === (provider as AiProvider),
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
          'Plan-Execute 模式的 Executor 需要工具调用能力。',
      );
    }
  }

  /**
   * 从消息中提取 token 使用统计
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

  /**
   * 从消息列表中聚合 token 使用量
   *
   * 复用 extractUsage 做单条消息的类型安全提取，此处仅负责聚合。
   */
  private extractUsageFromMessages(
    messages: unknown[],
  ): TokenUsage | undefined {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let found = false;

    for (const msg of messages) {
      if (msg instanceof AIMessage) {
        const usage = this.extractUsage(msg);
        if (usage) {
          promptTokens += usage.promptTokens;
          completionTokens += usage.completionTokens;
          totalTokens += usage.totalTokens;
          found = true;
        }
      }
    }

    return found ? { promptTokens, completionTokens, totalTokens } : undefined;
  }
}
