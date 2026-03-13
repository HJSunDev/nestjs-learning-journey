import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from 'src/common/redis/redis.module';
import { RedisChatHistory } from './redis-chat-history';
import { MEMORY_KEY_PREFIX } from './memory.constants';

/**
 * 会话历史的信息摘要（不含完整消息体）
 */
export interface SessionInfo {
  sessionId: string;
  /** Redis Key 的剩余 TTL（秒），-1 表示无过期，-2 表示 Key 不存在 */
  ttl: number;
  messageCount: number;
}

/**
 * 会话管理服务
 *
 * 提供对话历史的 管理端 操作（查询、删除），
 * 与 ChatHistoryFactory（创建实例供链使用）形成互补。
 * ChatHistoryFactory 和 RedisChatHistory 解决的是对话运行时的问题：用户发消息 → 加载历史 → 调用模型 → 写回新消息。
 *
 * 但生产环境还需要管理端功能：
 * 这些是运行时不需要，但管理端必需的操作：
 * await sessionManager.listSessions();        // 列出所有活跃会话
 * await sessionManager.getSessionInfo(id);    // 查看会话元信息（TTL、消息数）
 * await sessionManager.clearSession(id);      // 强制清除某个会话
 * await sessionManager.getSessionMessages(id); // 调试时查看完整历史
 *
 * 通过原始 ioredis 命令直接操作 Redis，
 * 不依赖 LangChain 抽象——管理端不需要消息反序列化的完整语义。
 */
@Injectable()
export class SessionManagerService {
  private readonly logger = new Logger(SessionManagerService.name);
  private readonly keyPrefix: string;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    configService: ConfigService,
  ) {
    this.keyPrefix =
      configService.get<string>('ai.memory.keyPrefix') ?? MEMORY_KEY_PREFIX;
  }

  /**
   * 获取指定会话的消息列表
   *
   * 通过临时创建 RedisChatHistory 实例来反序列化消息，
   * 复用 LangChain 的 StoredMessage → BaseMessage 转换逻辑。
   */
  async getSessionMessages(sessionId: string) {
    const history = new RedisChatHistory({
      client: this.redis,
      sessionKey: `${this.keyPrefix}${sessionId}`,
    });

    const messages = await history.getMessages();
    return messages.map((msg) => ({
      role: msg.type,
      content:
        typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content),
    }));
  }

  /**
   * 获取指定会话的元信息
   *
   * "元信息"指关于会话的描述性数据，区别于消息内容本身：
   * - 元信息：会话 ID、消息条数、剩余存活时间等统计数据
   * - 消息内容：用户和 AI 之间的具体对话文本
   *
   * @param sessionId - 会话唯一标识符（业务侧传入的 ID）
   * @returns 会话元信息对象
   * @returns sessionId - 会话 ID
   * @returns ttl - 剩余存活时间（秒）；-1 表示永不过期，-2 表示 Key 不存在
   * @returns messageCount - 消息总条数
   *
   * @example
   * const info = await sessionManager.getSessionInfo('user-123');
   * // { sessionId: 'user-123', ttl: 3600, messageCount: 10 }
   *
   */
  async getSessionInfo(sessionId: string): Promise<SessionInfo> {
    const key = `${this.keyPrefix}${sessionId}`;
    const pipeline = this.redis.pipeline();
    pipeline.llen(key);
    pipeline.ttl(key);
    const results = await pipeline.exec();

    const messageCount = (results?.[0]?.[1] as number) ?? 0;
    const ttl = (results?.[1]?.[1] as number) ?? -2;

    return { sessionId, ttl, messageCount };
  }

  /**
   * 清除指定会话的全部历史
   *
   * @returns 被删除的消息条数
   * @throws NotFoundException 当 sessionId 对应的会话不存在时
   */
  async clearSession(sessionId: string): Promise<{ messageCount: number }> {
    const key = `${this.keyPrefix}${sessionId}`;

    const pipeline = this.redis.pipeline();
    pipeline.llen(key);
    pipeline.del(key);
    const results = await pipeline.exec();

    const messageCount = (results?.[0]?.[1] as number) ?? 0;
    const deletedCount = (results?.[1]?.[1] as number) ?? 0;

    if (deletedCount === 0) {
      throw new NotFoundException(`会话 ${sessionId} 不存在`);
    }

    this.logger.log(`会话 ${sessionId} 已清除，共删除 ${messageCount} 条消息`);
    return { messageCount };
  }

  /**
   * 列出所有活跃会话
   *
   * 使用 SCAN 遍历匹配前缀的 Key，避免 KEYS 命令阻塞 Redis。
   * 生产环境中应配合分页使用。
   */
  async listSessions(): Promise<SessionInfo[]> {
    const pattern = `${this.keyPrefix}*`;
    const keys: string[] = [];
    let cursor = '0';

    do {
      const [nextCursor, batch] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        100,
      );
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');

    if (keys.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const key of keys) {
      pipeline.llen(key);
      pipeline.ttl(key);
    }
    const results = await pipeline.exec();

    return keys.map((key, idx) => ({
      sessionId: key.replace(this.keyPrefix, ''),
      messageCount: (results?.[idx * 2]?.[1] as number) ?? 0,
      ttl: (results?.[idx * 2 + 1]?.[1] as number) ?? -2,
    }));
  }
}
