import { BaseListChatMessageHistory } from '@langchain/core/chat_history';
import type { BaseMessage } from '@langchain/core/messages';
import {
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
} from '@langchain/core/messages';
import type Redis from 'ioredis';

/**
 * 基于 ioredis 的对话历史存储
 *
 * 自行实现而非引入 @langchain/community 的原因：
 * 1. 避免引入巨型包（500+ 集成）带来的依赖冲突（dotenv 版本不兼容）
 * 2. 复用项目已有的 ioredis 客户端，无需额外连接
 * 3. 核心逻辑仅为 Redis List 的 RPUSH / LRANGE / DEL + TTL 管理
 *
 * 存储结构：
 * - Key:   `{prefix}{sessionId}`
 * - Type:  Redis List
 * - Value: 每个元素是一条 StoredMessage 的 JSON 序列化字符串
 * - TTL:   可选，通过 EXPIRE 自动过期
 */
export class RedisChatHistory extends BaseListChatMessageHistory {
  lc_namespace = ['langchain', 'stores', 'message', 'ioredis'];

  private readonly client: Redis;
  private readonly sessionKey: string;
  private readonly sessionTTL?: number;

  constructor(fields: {
    client: Redis;
    /** 完整的 Redis Key（已包含前缀） */
    sessionKey: string;
    /** 会话 TTL（秒），每次写入后刷新 */
    sessionTTL?: number;
  }) {
    super();
    this.client = fields.client;
    this.sessionKey = fields.sessionKey;
    this.sessionTTL = fields.sessionTTL;
  }

  async getMessages(): Promise<BaseMessage[]> {
    // 从 Redis List 中读取所有消息
    const raw = await this.client.lrange(this.sessionKey, 0, -1);
    const stored = raw.map(
      (item) => JSON.parse(item) as ReturnType<BaseMessage['toDict']>,
    );
    // 将 StoredMessage 转换为 BaseMessage
    return mapStoredMessagesToChatMessages(stored);
  }

  async addMessage(message: BaseMessage): Promise<void> {
    // 将 BaseMessage 转换为 StoredMessage
    const [serialized] = mapChatMessagesToStoredMessages([message]);
    // 将 StoredMessage 写入 Redis List尾部
    await this.client.rpush(this.sessionKey, JSON.stringify(serialized));
    await this.refreshTTL();
  }

  async addMessages(messages: BaseMessage[]): Promise<void> {
    const serialized = mapChatMessagesToStoredMessages(messages);
    // 使用 Pipeline 批量写入 Redis List（减少网络往返，一次发送多条命令）
    const pipeline = this.client.pipeline();
    // 遍历所有 StoredMessage，依次写入 Redis List
    for (const msg of serialized) {
      pipeline.rpush(this.sessionKey, JSON.stringify(msg));
    }
    // 执行 Pipeline 批量写入
    await pipeline.exec();
    await this.refreshTTL();
  }

  async clear(): Promise<void> {
    await this.client.del(this.sessionKey);
  }

  /**
   * 每次写入后刷新 TTL，实现"滑动过期"语义：
   * 只要用户持续对话，会话就不会过期。
   */
  private async refreshTTL(): Promise<void> {
    if (this.sessionTTL && this.sessionTTL > 0) {
      // 刷新 TTL，保持会话活跃
      await this.client.expire(this.sessionKey, this.sessionTTL);
    }
  }
}
