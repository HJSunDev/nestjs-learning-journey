import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Runnable } from '@langchain/core/runnables';
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { AIMessageChunk } from '@langchain/core/messages';
import { Subject } from 'rxjs';

import { ToolRegistry } from './tool.registry';
import { StreamChunkType } from '../constants';
import type { StreamChunk, ToolCallInfo, ToolResultInfo } from '../interfaces';
import { convertToLangChainMessages } from '../utils';
import type { Message } from '../interfaces';

/** 单轮工具调用记录 */
export interface ToolCallRound {
  /** 轮次序号（从 1 开始） */
  round: number;
  /** 本轮模型发起的工具调用列表 */
  toolCalls: ToolCallInfo[];
  /** 本轮工具执行结果列表 */
  toolResults: ToolResultInfo[];
}

/** 工具调用循环的最终结果 */
export interface ToolCallingResult {
  /** 模型的最终文本响应 */
  content: string;
  /** 所有工具调用轮次的历史记录 */
  rounds: ToolCallRound[];
  /** 总共经历的工具调用轮次数 */
  totalRounds: number;
  /** Token 使用统计 */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** 完成原因 */
  finishReason?: string;
}

/**
 * 防止无限循环的默认最大迭代次数
 *
 * 大多数实际场景下 2-3 轮即可完成，5 轮足以覆盖复杂的多工具组合调用。
 * 超过此限制通常意味着 prompt 设计有问题或模型在循环调用同一工具。
 */
const DEFAULT_MAX_ITERATIONS = 5;

/**
 * 工具调用循环引擎
 *
 * 实现 Tool Calling 的核心 Agentic Loop：
 *
 * ```
 * ┌──────────────────────────────────────────────┐
 * │  用户消息 + 工具定义 → model.bindTools(tools)
 * │            ↓
 * │  模型推理 → AIMessage
 * │            ↓
 * │  有 tool_calls?
 * │   ├─ 是 → 执行工具 → ToolMessage → 重新推理
 * │   └─ 否 → 返回最终文本响应
 * └──────────────────────────────────────────────┘
 * ```
 *
 * 设计原则：
 * - 不依赖 LCEL 链，直接操作 model.bindTools() + invoke/stream
 * - 工具执行失败不终止循环，将错误信息作为 ToolMessage 返回给模型
 * - 通过 maxIterations 防止无限循环
 * - 通过 AbortController + timeoutMs 防止整体耗时过长
 * - 支持非流式（execute）和流式（streamExecute）两种模式
 */
@Injectable()
export class ToolCallingLoop {
  private readonly logger = new Logger(ToolCallingLoop.name);

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 执行工具调用循环（非流式）
   *
   * 迭代过程：
   * 1. 将工具绑定到模型（model.bindTools）
   * 2. 调用模型，检查响应中是否包含 tool_calls
   * 3. 若有 tool_calls：执行工具 → 将结果作为 ToolMessage 追加 → 重新调用模型
   * 4. 若无 tool_calls：返回模型的文本响应作为最终结果
   * 5. 达到 maxIterations 上限时，移除工具绑定做最终调用
   *
   * 超时机制：
   * 通过 AbortController 设置整个循环的总超时。signal 传递给每次 invoke()，
   * 超时触发时当前 LLM 调用被中止，循环立即终止并抛出带调试上下文的错误。
   */
  async execute(params: {
    model: BaseChatModel;
    messages: Message[];
    systemPrompt?: string;
    toolNames?: string[];
    maxIterations?: number;
    /**
     * 整个循环的超时限制（毫秒）
     *
     * 未指定时使用 ai.timeout.toolCallingLoopMs 配置值。
     * 设为 0 表示不限制。
     */
    timeoutMs?: number;
  }): Promise<ToolCallingResult> {
    const maxIterations = params.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const tools = this.toolRegistry.getTools(params.toolNames);

    if (tools.length === 0) {
      throw new Error(
        '没有可用的工具。请检查工具名称是否正确，或确认 ToolRegistry 中已注册工具。',
      );
    }

    // 创建超时守卫
    const { signal, cleanup } = this.createTimeoutGuard(params.timeoutMs);
    // 将工具绑定到模型
    const modelWithTools = this.bindTools(params.model, tools);
    const currentMessages: BaseMessage[] = convertToLangChainMessages(
      params.messages,
      params.systemPrompt,
    );

    const rounds: ToolCallRound[] = [];
    const startTime = Date.now();

    try {
      for (let i = 0; i < maxIterations; i++) {
        this.logger.debug(`工具调用循环 - 第 ${i + 1}/${maxIterations} 轮`);

        const response = (await modelWithTools.invoke(currentMessages, {
          signal,
        })) as AIMessageChunk;

        if (!response.tool_calls?.length) {
          return this.buildResult(response, rounds);
        }

        const round = await this.executeToolCallRound(
          i + 1,
          response,
          currentMessages,
        );
        rounds.push(round);
      }

      // 达到最大迭代次数，移除工具绑定做最终推理
      this.logger.warn(
        `工具调用循环达到上限 (${maxIterations} 轮)，执行最终推理`,
      );
      const finalResponse = await params.model.invoke(currentMessages, {
        signal,
      });

      return this.buildResult(finalResponse, rounds);
    } catch (error) {
      throw this.handleLoopError(
        error,
        startTime,
        rounds.length,
        params.timeoutMs,
      );
    } finally {
      cleanup();
    }
  }

  /**
   * 执行工具调用循环（流式）
   *
   * 与非流式版本的核心循环逻辑一致，关键区别：
   * - 中间轮次（有 tool_calls）：使用 invoke 获取完整结果，
   *   通过 Subject 发射 TOOL_CALL 和 TOOL_RESULT 事件
   * - 最终轮次（纯文本）：使用 stream 逐 chunk 发射 TEXT 事件
   *
   * 中间轮次用 invoke 而非 stream 的原因：
   * tool_calls 需要完整收集后才能执行，流式传输 tool_call_chunks
   * 对用户体验没有帮助（用户看不到工具调用的 JSON 参数），
   * 但会增加实现复杂度（需要手动 concat chunks）。
   *
   * @param params 同 execute
   * @returns RxJS Subject 的 Observable
   */
  streamExecute(params: {
    model: BaseChatModel;
    messages: Message[];
    systemPrompt?: string;
    toolNames?: string[];
    maxIterations?: number;
    /** 整个循环的超时限制（毫秒），未指定时使用配置默认值，设为 0 不限制 */
    timeoutMs?: number;
  }): Subject<StreamChunk> {
    const subject = new Subject<StreamChunk>();

    void this.runStreamLoop(params, subject);

    return subject;
  }

  /**
   * 流式循环的异步执行体
   */
  private async runStreamLoop(
    params: {
      model: BaseChatModel;
      messages: Message[];
      systemPrompt?: string;
      toolNames?: string[];
      maxIterations?: number;
      timeoutMs?: number;
    },
    subject: Subject<StreamChunk>,
  ): Promise<void> {
    // 创建超时守卫
    const { signal, cleanup } = this.createTimeoutGuard(params.timeoutMs);
    // 记录开始时间
    const startTime = Date.now();
    // 记录完成的轮次
    let completedRounds = 0;

    try {
      const maxIterations = params.maxIterations ?? DEFAULT_MAX_ITERATIONS;
      const tools = this.toolRegistry.getTools(params.toolNames);

      if (tools.length === 0) {
        subject.next({
          type: StreamChunkType.ERROR,
          error: '没有可用的工具',
        });
        subject.complete();
        return;
      }

      const modelWithTools = this.bindTools(params.model, tools);
      const currentMessages: BaseMessage[] = convertToLangChainMessages(
        params.messages,
        params.systemPrompt,
      );

      for (let i = 0; i < maxIterations; i++) {
        this.logger.debug(
          `[Stream] 工具调用循环 - 第 ${i + 1}/${maxIterations} 轮`,
        );

        // 中间轮次：用 invoke 获取完整的 tool_calls,传入 AbortSignal 防止超时
        const response = (await modelWithTools.invoke(currentMessages, {
          signal,
        })) as AIMessageChunk;

        if (!response.tool_calls?.length) {
          // 最终轮次：对同样的消息发起流式调用以获取逐 chunk 输出
          await this.streamFinalResponse(
            modelWithTools,
            currentMessages,
            subject,
            signal,
          );
          return;
        }

        // 发射工具调用事件并执行
        await this.emitToolCallRound(i + 1, response, currentMessages, subject);
        completedRounds = i + 1;
      }

      // 达到最大迭代次数
      this.logger.warn(`[Stream] 工具调用循环达到上限 (${maxIterations} 轮)`);
      await this.streamFinalResponse(
        params.model,
        currentMessages,
        subject,
        signal,
      );
    } catch (error) {
      const wrapped = this.handleLoopError(
        error,
        startTime,
        completedRounds,
        params.timeoutMs,
      );
      this.logger.error('流式工具调用循环发生错误', wrapped);
      subject.next({
        type: StreamChunkType.ERROR,
        error: wrapped.message,
      });
      subject.complete();
    } finally {
      cleanup();
    }
  }

  /**
   * 执行单轮工具调用
   *
   * 将模型返回的 tool_calls 逐个执行，收集结果，
   * 并将 AIMessage + ToolMessage 追加到对话历史中。
   */
  private async executeToolCallRound(
    roundNumber: number,
    response: AIMessageChunk,
    currentMessages: BaseMessage[],
  ): Promise<ToolCallRound> {
    const round: ToolCallRound = {
      round: roundNumber,
      toolCalls: [],
      toolResults: [],
    };

    // 将模型的 AIMessage（含 tool_calls）追加到对话历史
    currentMessages.push(
      new AIMessage({
        content: typeof response.content === 'string' ? response.content : '',
        tool_calls: response.tool_calls,
      }),
    );

    for (const toolCall of response.tool_calls!) {
      const callId =
        toolCall.id ??
        `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      const callInfo: ToolCallInfo = {
        id: callId,
        name: toolCall.name,
        arguments: toolCall.args as Record<string, unknown>,
      };
      round.toolCalls.push(callInfo);

      this.logger.debug(
        `[Round ${roundNumber}] 执行工具: ${toolCall.name}`,
        toolCall.args,
      );

      const result = await this.toolRegistry.execute(
        toolCall.name,
        toolCall.args as Record<string, unknown>,
      );

      const resultInfo: ToolResultInfo = {
        toolCallId: callId,
        name: toolCall.name,
        result,
      };
      round.toolResults.push(resultInfo);

      // 将工具执行结果作为 ToolMessage 追加到对话历史
      currentMessages.push(
        new ToolMessage({
          content: typeof result === 'string' ? result : JSON.stringify(result),
          tool_call_id: callId,
        }),
      );
    }

    this.logger.log(
      `[Round ${roundNumber}] 完成 ${round.toolCalls.length} 个工具调用`,
    );
    return round;
  }

  /**
   * 发射流式工具调用事件
   *
   * 与 executeToolCallRound 逻辑一致，
   * 额外通过 Subject 发射 TOOL_CALL 和 TOOL_RESULT 事件。
   */
  private async emitToolCallRound(
    roundNumber: number,
    response: AIMessageChunk,
    currentMessages: BaseMessage[],
    subject: Subject<StreamChunk>,
  ): Promise<void> {
    currentMessages.push(
      new AIMessage({
        content: typeof response.content === 'string' ? response.content : '',
        tool_calls: response.tool_calls,
      }),
    );

    for (const toolCall of response.tool_calls!) {
      const callId =
        toolCall.id ??
        `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      // 发射 TOOL_CALL 事件
      subject.next({
        type: StreamChunkType.TOOL_CALL,
        toolCall: {
          id: callId,
          name: toolCall.name,
          arguments: toolCall.args as Record<string, unknown>,
        },
      });

      const result = await this.toolRegistry.execute(
        toolCall.name,
        toolCall.args as Record<string, unknown>,
      );

      // 发射 TOOL_RESULT 事件
      subject.next({
        type: StreamChunkType.TOOL_RESULT,
        toolResult: {
          toolCallId: callId,
          name: toolCall.name,
          result,
        },
      });

      currentMessages.push(
        new ToolMessage({
          content: typeof result === 'string' ? result : JSON.stringify(result),
          tool_call_id: callId,
        }),
      );
    }
  }

  /**
   * 将工具绑定到模型
   *
   * bindTools 在 BaseChatModel 类型定义中是可选方法，
   * 此处做防御性检查，确保模型实现了该方法。
   */
  private bindTools(
    model: BaseChatModel,
    tools: ReturnType<typeof this.toolRegistry.getTools>,
  ): Runnable {
    if (typeof model.bindTools !== 'function') {
      throw new Error(
        '当前模型不支持 bindTools 方法，无法使用工具调用功能。' +
          '请确认模型实现了 tool calling 协议。',
      );
    }
    return model.bindTools(tools);
  }

  /**
   * 流式输出最终响应
   *
   * 在工具调用循环结束后，对完整的对话历史（含工具结果）
   * 发起流式调用，逐 chunk 发射 TEXT 事件。
   */
  private async streamFinalResponse(
    model: Runnable,
    messages: BaseMessage[],
    subject: Subject<StreamChunk>,
    signal?: AbortSignal,
  ): Promise<void> {
    const stream = await model.stream(messages, { signal });
    let usage: ToolCallingResult['usage'];
    let finishReason: string | undefined;

    for await (const chunk of stream) {
      const aiChunk = chunk as AIMessageChunk;

      // 提取 token usage（通常在最后一个 chunk 中）
      const currentUsage = this.extractTokenUsage(aiChunk);
      if (currentUsage) usage = currentUsage;

      const currentFinishReason = this.extractFinishReason(aiChunk);
      if (currentFinishReason) finishReason = currentFinishReason;

      if (aiChunk.content) {
        subject.next({
          type: StreamChunkType.TEXT,
          content:
            typeof aiChunk.content === 'string'
              ? aiChunk.content
              : JSON.stringify(aiChunk.content),
        });
      }
    }

    subject.next({
      type: StreamChunkType.DONE,
      usage,
      finishReason,
    });
    subject.complete();
  }

  /**
   * 构建最终结果
   */
  private buildResult(
    response: AIMessageChunk,
    rounds: ToolCallRound[],
  ): ToolCallingResult {
    return {
      content:
        typeof response.content === 'string'
          ? response.content
          : JSON.stringify(response.content),
      rounds,
      totalRounds: rounds.length,
      usage: this.extractTokenUsage(response),
      finishReason: this.extractFinishReason(response),
    };
  }

  /**
   * 创建超时守卫
   *
   * 返回 AbortSignal 和 cleanup 函数。signal 传递给 invoke/stream，
   * 超时触发时 abort() 中止当前 LLM 调用。
   * cleanup 在 finally 中调用以清理定时器，防止内存泄漏。
   *
   * @param timeoutMs 超时时间（毫秒），undefined 使用配置默认值，0 表示不限制
   */
  private createTimeoutGuard(timeoutMs?: number): {
    signal: AbortSignal | undefined;
    cleanup: () => void;
  } {
    const resolvedTimeout =
      timeoutMs ??
      this.configService.get<number>('ai.timeout.toolCallingLoopMs');

    if (!resolvedTimeout || resolvedTimeout <= 0) {
      return { signal: undefined, cleanup: () => {} };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), resolvedTimeout);

    this.logger.debug(`工具调用循环超时守卫已启动: ${resolvedTimeout}ms`);

    return {
      signal: controller.signal,
      cleanup: () => clearTimeout(timer),
    };
  }

  /**
   * 统一处理循环中的错误
   *
   * 将 AbortError 包装为包含调试上下文的业务错误（实际耗时、已完成轮次等），
   * 非超时错误原样返回。
   */
  private handleLoopError(
    error: unknown,
    startTime: number,
    completedRounds: number,
    timeoutMs?: number,
  ): Error {
    if (error instanceof Error && error.name === 'AbortError') {
      const elapsed = Date.now() - startTime;
      const limit =
        timeoutMs ??
        this.configService.get<number>('ai.timeout.toolCallingLoopMs') ??
        0;
      return new Error(
        `工具调用循环超时: 已执行 ${elapsed}ms (限制 ${limit}ms), ` +
          `完成 ${completedRounds} 轮工具调用后中止`,
      );
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private extractTokenUsage(
    result: AIMessageChunk,
  ): ToolCallingResult['usage'] | undefined {
    const usageMeta = result.usage_metadata;
    if (usageMeta) {
      return {
        promptTokens: usageMeta.input_tokens ?? 0,
        completionTokens: usageMeta.output_tokens ?? 0,
        totalTokens: usageMeta.total_tokens ?? 0,
      };
    }
    return undefined;
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
