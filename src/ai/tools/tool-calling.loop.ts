import { Injectable, Logger } from '@nestjs/common';
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
 * - 支持非流式（execute）和流式（streamExecute）两种模式
 */
@Injectable()
export class ToolCallingLoop {
  private readonly logger = new Logger(ToolCallingLoop.name);

  constructor(private readonly toolRegistry: ToolRegistry) {}

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
   * @param params.model          由 AiModelFactory 创建的模型实例
   * @param params.messages       项目内部消息列表
   * @param params.systemPrompt   可选系统提示词
   * @param params.toolNames      要启用的工具名称列表（为空则启用全部）
   * @param params.maxIterations  最大迭代次数
   */
  async execute(params: {
    model: BaseChatModel;
    messages: Message[];
    systemPrompt?: string;
    toolNames?: string[];
    maxIterations?: number;
  }): Promise<ToolCallingResult> {
    const maxIterations = params.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const tools = this.toolRegistry.getTools(params.toolNames);

    if (tools.length === 0) {
      throw new Error(
        '没有可用的工具。请检查工具名称是否正确，或确认 ToolRegistry 中已注册工具。',
      );
    }

    const modelWithTools = this.bindTools(params.model, tools);
    const currentMessages: BaseMessage[] = convertToLangChainMessages(
      params.messages,
      params.systemPrompt,
    );

    const rounds: ToolCallRound[] = [];

    for (let i = 0; i < maxIterations; i++) {
      this.logger.debug(`工具调用循环 - 第 ${i + 1}/${maxIterations} 轮`);

      const response = (await modelWithTools.invoke(
        currentMessages,
      )) as AIMessageChunk;

      // 没有 tool_calls 表示模型已完成推理，返回最终结果
      if (!response.tool_calls?.length) {
        return this.buildResult(response, rounds);
      }

      // 执行本轮的所有工具调用
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
    const finalResponse = await params.model.invoke(currentMessages);

    return this.buildResult(finalResponse, rounds);
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
    },
    subject: Subject<StreamChunk>,
  ): Promise<void> {
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

        // 中间轮次：用 invoke 获取完整的 tool_calls
        const response = (await modelWithTools.invoke(
          currentMessages,
        )) as AIMessageChunk;

        if (!response.tool_calls?.length) {
          // 最终轮次：对同样的消息发起流式调用以获取逐 chunk 输出
          await this.streamFinalResponse(
            modelWithTools,
            currentMessages,
            subject,
          );
          return;
        }

        // 发射工具调用事件并执行
        await this.emitToolCallRound(i + 1, response, currentMessages, subject);
      }

      // 达到最大迭代次数
      this.logger.warn(`[Stream] 工具调用循环达到上限 (${maxIterations} 轮)`);
      await this.streamFinalResponse(params.model, currentMessages, subject);
    } catch (error) {
      this.logger.error('流式工具调用循环发生错误', error);
      subject.next({
        type: StreamChunkType.ERROR,
        error: error instanceof Error ? error.message : String(error),
      });
      subject.complete();
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
  ): Promise<void> {
    const stream = await model.stream(messages);
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
