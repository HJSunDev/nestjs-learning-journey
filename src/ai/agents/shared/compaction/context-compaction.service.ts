import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type BaseMessage,
  SystemMessage,
  HumanMessage,
  AIMessage,
} from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * 上下文压缩结果
 */
export interface CompactionResult {
  /** 压缩后的消息列表 */
  messages: BaseMessage[];
  /** 是否执行了压缩（false 表示消息未超限，直接返回） */
  compacted: boolean;
  /** 压缩前的消息数量 */
  originalCount: number;
  /** 压缩后的消息数量 */
  compactedCount: number;
  /** 使用的压缩策略 */
  strategy: 'none' | 'trim' | 'summarize';
}

/**
 * 上下文压缩配置
 */
export interface CompactionOptions {
  /** 最大消息数量（超过此数量触发压缩，默认从配置读取） */
  maxMessages?: number;
  /** 压缩策略：trim 仅裁剪 / summarize 先摘要再裁剪（默认 trim） */
  strategy?: 'trim' | 'summarize';
  /** 用于摘要的模型实例（仅 summarize 策略需要） */
  summaryModel?: BaseChatModel;
  /** 保留最近多少条消息不被摘要（默认从配置读取） */
  preserveRecent?: number;
}

/**
 * 上下文压缩服务
 *
 * 解决长对话场景下消息累积导致的三个生产问题：
 * 1. 超出模型上下文窗口限制 → 请求直接报错
 * 2. Token 消耗线性增长 → 成本不可控
 * 3. 上下文噪声（context rot）→ 模型注意力被稀释，输出质量下降
 *
 * 提供两种压缩策略：
 * - **trim**：基于 @langchain/core 的 trimMessages，保留 SystemMessage + 最近 N 条消息。
 *   优势是零 LLM 调用、延迟极低（<1ms），适合大部分场景。
 * - **summarize**：将旧消息压缩为摘要 SystemMessage，再保留最近消息。
 *   需要额外 LLM 调用，适合需要保留历史语义的场景。
 *
 * 设计要点：
 * - 不修改原始消息数组（不可变操作）
 * - SystemMessage 始终保留（不参与裁剪）
 * - ToolMessage 与其前置 AIMessage 保持配对完整性（避免模型执行异常）
 */
@Injectable()
export class ContextCompactionService {
  private readonly logger = new Logger(ContextCompactionService.name);
  private readonly defaultMaxMessages: number;
  private readonly defaultPreserveRecent: number;

  constructor(private readonly configService: ConfigService) {
    this.defaultMaxMessages = this.configService.get<number>(
      'ai.compaction.maxMessages',
      50,
    );
    this.defaultPreserveRecent = this.configService.get<number>(
      'ai.compaction.preserveRecent',
      10,
    );

    this.logger.log(
      `上下文压缩服务已初始化: maxMessages=${this.defaultMaxMessages}, ` +
        `preserveRecent=${this.defaultPreserveRecent}`,
    );
  }

  /**
   * 对消息列表执行上下文压缩
   *
   * @param messages - 原始消息列表
   * @param options - 压缩配置选项
   * @returns 压缩结果（包含压缩后的消息和元信息）
   *
   * @example
   * // 参数示例
   * const messages = [systemMsg, ...fiftyRoundsOfChat];
   * const options = { strategy: 'trim', maxMessages: 20 };
   *
   * // 调用示例
   * const result = await compactionService.compact(messages, options);
   *
   * // 返回值示例
   * // { messages: [systemMsg, ...last20Messages], compacted: true, strategy: 'trim', ... }
   */
  async compact(
    messages: BaseMessage[],
    options: CompactionOptions = {},
  ): Promise<CompactionResult> {
    const maxMessages = options.maxMessages ?? this.defaultMaxMessages;
    const strategy = options.strategy ?? 'trim';

    if (messages.length <= maxMessages) {
      return {
        messages,
        compacted: false,
        originalCount: messages.length,
        compactedCount: messages.length,
        strategy: 'none',
      };
    }

    this.logger.debug(
      `触发上下文压缩: ${messages.length} → ${maxMessages} (策略: ${strategy})`,
    );

    const compactedMessages =
      strategy === 'summarize' && options.summaryModel
        ? await this.summarizeAndTrim(messages, options)
        : this.trimOnly(messages, maxMessages);

    return {
      messages: compactedMessages,
      compacted: true,
      originalCount: messages.length,
      compactedCount: compactedMessages.length,
      strategy,
    };
  }

  /**
   * 仅裁剪策略
   *
   * 使用 @langchain/core 的 trimMessages 保留最近的消息，
   * 自动处理 SystemMessage 保留和消息配对完整性。
   */
  private trimOnly(messages: BaseMessage[], maxCount: number): BaseMessage[] {
    // 分离 SystemMessage（始终保留）
    const systemMessages = messages.filter((m) => m._getType() === 'system');
    const nonSystemMessages = messages.filter((m) => m._getType() !== 'system');

    // 保留最近 maxCount 条非系统消息
    const keepCount = Math.max(1, maxCount - systemMessages.length);
    const trimmed = nonSystemMessages.slice(-keepCount);

    // 确保 ToolMessage 的前置 AIMessage 存在
    const validated = this.ensureToolMessagePairing(trimmed);

    return [...systemMessages, ...validated];
  }

  /**
   * 摘要 + 裁剪策略
   *
   * 将超出保留窗口的旧消息用 LLM 压缩为一条摘要，
   * 注入为 SystemMessage 附在原 SystemMessage 之后。
   */
  private async summarizeAndTrim(
    messages: BaseMessage[],
    options: CompactionOptions,
  ): Promise<BaseMessage[]> {
    const preserveRecent = options.preserveRecent ?? this.defaultPreserveRecent;
    const model = options.summaryModel!;

    const systemMessages = messages.filter((m) => m._getType() === 'system');
    const nonSystemMessages = messages.filter((m) => m._getType() !== 'system');

    // 如果非系统消息不够多，直接裁剪
    if (nonSystemMessages.length <= preserveRecent) {
      return this.trimOnly(messages, preserveRecent + systemMessages.length);
    }

    // 分割：需要摘要的旧消息 / 保留的近期消息
    const oldMessages = nonSystemMessages.slice(0, -preserveRecent);
    const recentMessages = nonSystemMessages.slice(-preserveRecent);

    // 构造摘要提示
    const summaryPrompt = this.buildSummaryPrompt(oldMessages);

    try {
      const summaryResponse = await model.invoke([
        new HumanMessage(summaryPrompt),
      ]);

      const summaryContent =
        typeof summaryResponse.content === 'string'
          ? summaryResponse.content
          : JSON.stringify(summaryResponse.content);

      const summaryMessage = new SystemMessage(
        `[对话历史摘要]\n${summaryContent}`,
      );

      this.logger.debug(
        `摘要压缩完成: ${oldMessages.length} 条旧消息 → 1 条摘要 ` +
          `(${summaryContent.length} 字符)`,
      );

      const validated = this.ensureToolMessagePairing(recentMessages);
      return [...systemMessages, summaryMessage, ...validated];
    } catch (error) {
      // 摘要失败时降级为纯裁剪
      this.logger.warn(
        `摘要生成失败，降级为纯裁剪: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.trimOnly(messages, preserveRecent + systemMessages.length);
    }
  }

  /**
   * 构造摘要提示词
   *
   * 将旧消息序列化为文本，要求 LLM 生成简洁的对话摘要。
   */
  private buildSummaryPrompt(messages: BaseMessage[]): string {
    const conversationText = messages
      .map((m) => {
        const role = m._getType() === 'human' ? 'User' : 'Assistant';
        const content =
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `${role}: ${content}`;
      })
      .join('\n');

    return (
      '请将以下对话历史压缩为一段简洁的摘要，保留关键事实、决策和上下文。' +
      '摘要应当让后续对话能够理解之前讨论的要点，但不需要逐字复述。\n\n' +
      `对话记录 (${messages.length} 条消息):\n${conversationText}\n\n` +
      '请输出摘要：'
    );
  }

  /**
   * 确保 ToolMessage 的前置 AIMessage（含 tool_calls）存在
   *
   * 如果裁剪导致 ToolMessage 失去了配对的 AIMessage，
   * 会移除这些孤立的 ToolMessage 以避免模型执行异常。
   */
  private ensureToolMessagePairing(messages: BaseMessage[]): BaseMessage[] {
    const result: BaseMessage[] = [];
    let hasToolCallAI = false;

    for (const msg of messages) {
      if (msg._getType() === 'ai') {
        const aiMsg = msg as AIMessage;
        hasToolCallAI =
          Array.isArray(aiMsg.tool_calls) && aiMsg.tool_calls.length > 0;
        result.push(msg);
      } else if (msg._getType() === 'tool') {
        // ToolMessage 仅在前面有包含 tool_calls 的 AIMessage 时保留
        if (hasToolCallAI) {
          result.push(msg);
        } else {
          this.logger.debug('移除孤立 ToolMessage（前置 AIMessage 被裁剪）');
        }
      } else {
        hasToolCallAI = false;
        result.push(msg);
      }
    }

    return result;
  }
}
