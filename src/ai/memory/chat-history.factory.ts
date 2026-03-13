import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BaseChatMessageHistory } from '@langchain/core/chat_history';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from 'src/common/redis/redis.module';
import { RedisChatHistory } from './redis-chat-history';
import { WindowedChatHistory } from './windowed-chat-history';
import {
  MEMORY_KEY_PREFIX,
  DEFAULT_SESSION_TTL,
  DEFAULT_WINDOW_SIZE,
} from './memory.constants';

export interface ChatHistoryOptions {
  /** 会话 TTL（秒），覆盖默认值 */
  ttl?: number;
  /** 历史窗口大小（消息条数），覆盖默认值；0 = 不裁剪 */
  windowSize?: number;
}

/**
 * 对话历史工厂
 *
 * 负责按 sessionId 创建 BaseChatMessageHistory 实例，
 * 供 RunnableWithMessageHistory 在每次请求时调用。
 *
 * 职责边界：
 * - 拼接 Redis Key（前缀 + sessionId）
 * - 注入已有的 ioredis 客户端（复用连接池）
 * - 根据 windowSize 决定是否包装 WindowedChatHistory 装饰器
 * - 读取 ConfigService 中的默认值作为兜底
 */
@Injectable()
export class ChatHistoryFactory {
  private readonly defaultTTL: number;
  private readonly defaultWindowSize: number;
  private readonly keyPrefix: string;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    configService: ConfigService,
  ) {
    const memoryConfig =
      configService.get<Record<string, number | string>>('ai.memory');
    this.defaultTTL =
      (memoryConfig?.defaultSessionTTL as number) ?? DEFAULT_SESSION_TTL;
    this.defaultWindowSize =
      (memoryConfig?.defaultWindowSize as number) ?? DEFAULT_WINDOW_SIZE;
    this.keyPrefix = (memoryConfig?.keyPrefix as string) ?? MEMORY_KEY_PREFIX;
  }

  /**
   * 创建对话历史实例
   *
   * @param sessionId 会话标识符（业务侧唯一 ID）
   * @param options   可选的 TTL 和窗口大小覆盖
   * @returns BaseChatMessageHistory 实例（可能被 WindowedChatHistory 包装）
   */
  create(
    sessionId: string,
    options?: ChatHistoryOptions,
  ): BaseChatMessageHistory {
    const ttl = options?.ttl ?? this.defaultTTL;
    const windowSize = options?.windowSize ?? this.defaultWindowSize;

    const history = new RedisChatHistory({
      client: this.redis,
      sessionKey: `${this.keyPrefix}${sessionId}`,
      sessionTTL: ttl,
    });

    // 如果 windowSize 大于 0，则使用“滑动窗口”装饰器包装 RedisChatHistory
    if (windowSize > 0) {
      return new WindowedChatHistory(history, windowSize);
    }

    return history;
  }
}
