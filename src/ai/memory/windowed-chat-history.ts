import { BaseChatMessageHistory } from '@langchain/core/chat_history';
import type { BaseMessage } from '@langchain/core/messages';

/**
 * 滑动窗口装饰器（Decorator Pattern）
 *
 * 包装任意 BaseChatMessageHistory 实现，对 getMessages() 施加窗口裁剪：
 * - 写入侧：全量持久化到底层存储（Redis），保留完整对话记录
 * - 读取侧：只返回最近 N 条消息，控制发送给模型的上下文长度
 *
 * 这种"写全量、读窗口"的设计兼顾了：
 * 1. 模型 context window 的 token 预算管理
 * 2. 历史记录的完整性（可用于审计、回溯、后续 Summary 策略升级）
 */
export class WindowedChatHistory extends BaseChatMessageHistory {
  lc_namespace = ['langchain', 'stores', 'message', 'windowed'];

  constructor(
    private readonly inner: BaseChatMessageHistory,
    private readonly windowSize: number,
  ) {
    // 调用父类 BaseChatMessageHistory 的构造函数
    super();
  }

  async getMessages(): Promise<BaseMessage[]> {
    const messages = await this.inner.getMessages();
    if (this.windowSize <= 0) return messages;
    // slice 负数参数表示从数组末尾倒数，-windowSize 即取最后 N 条消息
    return messages.slice(-this.windowSize);
  }

  async addMessage(message: BaseMessage): Promise<void> {
    return this.inner.addMessage(message);
  }

  async addMessages(messages: BaseMessage[]): Promise<void> {
    return this.inner.addMessages(messages);
  }

  async addUserMessage(message: string): Promise<void> {
    return this.inner.addUserMessage(message);
  }

  async addAIMessage(message: string): Promise<void> {
    return this.inner.addAIMessage(message);
  }

  async clear(): Promise<void> {
    return this.inner.clear();
  }
}
