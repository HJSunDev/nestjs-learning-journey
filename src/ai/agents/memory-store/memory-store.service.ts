import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InMemoryStore, type BaseStore } from '@langchain/langgraph';
import { PostgresStore } from '@langchain/langgraph-checkpoint-postgres/store';

import { EmbeddingsFactory } from '../../rag/embeddings.factory';
import {
  MemoryType,
  STORE_NAMESPACES,
  type MemoryValue,
  type StoreConfig,
} from './memory-store.types';

/**
 * 长期记忆存储服务 — 管理 LangGraph BaseStore 的生命周期
 *
 * 职责：
 * 1. 根据配置决定使用 PostgresStore（生产）还是 InMemoryStore（开发/降级）
 * 2. 配置向量搜索能力（Embedding 集成），支持语义相似度检索
 * 3. 提供 getStore() 供 Graph 编译时注入 store
 * 4. 封装记忆/技能的 CRUD 操作（命名空间隔离）
 * 5. 在模块销毁时释放数据库连接
 *
 * 设计决策：
 * - 与 CheckpointService 对称设计（Checkpointer 管线程状态，Store 管跨线程记忆）
 * - PostgresStore 复用同一 PostgreSQL 实例但管理独立的表（store 表与 checkpoint 表互不影响）
 * - 通过 EmbeddingsFactory 复用 RAG 模块的向量化能力
 *
 * 命名空间设计：
 * - 记忆：["memories", userId, memoryType] — 按用户和记忆类型隔离
 *
 * 技能扩展已迁移到文件系统方案（SkillLoaderService），不再使用 Store。
 */
@Injectable()
export class MemoryStoreService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MemoryStoreService.name);

  private store: BaseStore;
  private postgresStore: PostgresStore | null = null;
  private ready = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly embeddingsFactory: EmbeddingsFactory,
  ) {}

  /**
   * 模块初始化 — 创建并配置 Store
   *
   * PostgresStore.setup() 会创建 store 专用表和 pgvector 索引，
   * 已存在的表不会被重复创建（幂等操作）。
   */
  async onModuleInit(): Promise<void> {
    const config = this.getStoreConfig();

    // 如果禁用 PostgresStore，则使用 InMemoryStore
    if (!config.enabled) {
      this.store = this.createInMemoryStore(config);
      this.ready = true;
      this.logger.log(
        'Store 长期记忆已禁用 PostgresStore，使用 InMemoryStore（重启后数据丢失）',
      );
      return;
    }

    // 如果启用 PostgresStore，则使用 PostgresStore
    try {
      // 构建 PostgreSQL 连接字符串
      const connString = this.buildConnectionString();
      // 创建 Embeddings 实例
      const embeddings = this.embeddingsFactory.create();

      // 创建 PostgresStore 实例
      this.postgresStore = PostgresStore.fromConnString(connString, {
        index: {
          dims: config.embeddingDimensions,
          embed: embeddings,
          fields: ['content'],
        },
        ttl:
          config.memoryTtlSeconds > 0
            ? { defaultTtl: Math.ceil(config.memoryTtlSeconds / 60) }
            : undefined,
      });

      // 确保表结构存在
      await this.postgresStore.setup();
      // 设置 Store 实例
      this.store = this.postgresStore;
      this.ready = true;
      // 记录日志
      this.logger.log(
        `PostgresStore 初始化完成 [dims=${config.embeddingDimensions}, ` +
          `ttl=${config.memoryTtlSeconds > 0 ? config.memoryTtlSeconds + 's' : 'off'}]`,
      );
    } catch (error) {
      this.logger.warn(
        'PostgresStore 初始化失败，降级为 InMemoryStore。' +
          `错误: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.store = this.createInMemoryStore(config);
      this.ready = true;
    }
  }

  /**
   * 模块销毁 — 释放 PostgresStore 的数据库连接池
   */
  async onModuleDestroy(): Promise<void> {
    if (this.postgresStore) {
      try {
        await this.postgresStore.stop();
        this.logger.log('PostgresStore 连接池已释放');
      } catch (error) {
        this.logger.warn(
          `PostgresStore 连接池释放失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // ============================================================
  // Store 实例访问
  // ============================================================

  /**
   * 获取 Store 实例（用于 Graph 编译时注入）
   *
   * @returns 当前可用的 BaseStore（PostgresStore 或 InMemoryStore）
   * @throws {Error} 当服务尚未初始化时
   */
  getStore(): BaseStore {
    if (!this.ready) {
      throw new Error(
        'MemoryStoreService 尚未初始化，请确保在 onModuleInit 完成后调用',
      );
    }
    return this.store;
  }

  /**
   * 是否使用生产级持久化（PostgresStore）
   */
  isPostgresBacked(): boolean {
    return this.postgresStore !== null && this.ready;
  }

  // ============================================================
  // 记忆 CRUD 操作
  // ============================================================

  /**
   * 存储一条记忆
   *
   * @param userId - 用户标识
   * @param type - 记忆类型（semantic/episodic/procedural）
   * @param key - 记忆的唯一标识（UUID），用于在 namespace 分组内定位具体记录
   * @param value - 记忆内容
   *
   * @example
   * // 参数示例
   * const userId = 'user-123';
   * const type = MemoryType.SEMANTIC;
   * const key = crypto.randomUUID();
   * const value: MemoryValue = { content: '用户偏好暗色主题', type, source: 'extracted' };
   *
   * // 调用示例
   * await memoryStoreService.putMemory(userId, type, key, value);
   *
   * // 存储到命名空间 ["memories", "user-123", "semantic"]
   */
  async putMemory(
    userId: string,
    type: MemoryType,
    key: string,
    value: MemoryValue,
  ): Promise<void> {
    const namespace = this.resolveMemoryNamespace(userId, type);
    await this.store.put(
      namespace,
      key,
      value as unknown as Record<string, unknown>,
    );
  }

  /**
   * 获取指定记忆
   *
   * @param userId - 用户标识
   * @param type - 记忆类型
   * @param key - 记忆的唯一标识（UUID），用于在 namespace 分组内定位具体记录
   * @returns 记忆条目或 null
   */
  async getMemory(userId: string, type: MemoryType, key: string) {
    const namespace = this.resolveMemoryNamespace(userId, type);
    return this.store.get(namespace, key);
  }

  /**
   * 语义搜索记忆
   *
   * 通过向量相似度检索与查询语义最接近的记忆条目。
   *
   * @param userId - 用户标识
   * @param query - 自然语言搜索查询
   * @param options - 搜索选项
   * @returns 匹配的记忆列表
   *
   * @example
   * // 参数示例
   * const userId = 'user-123';
   * const query = '用户喜欢什么颜色的主题？';
   *
   * // 调用示例
   * const results = await memoryStoreService.searchMemories(userId, query, { limit: 5 });
   *
   * // 返回值示例
   * // [{ key: 'uuid-1', value: { content: '用户偏好暗色主题', ... }, score: 0.92 }]
   */
  async searchMemories(
    userId: string,
    query: string,
    options?: { type?: MemoryType; limit?: number },
  ) {
    const config = this.getStoreConfig();
    const limit = options?.limit ?? config.defaultSearchLimit;

    // 按记忆类型搜索或搜索所有类型
    const namespace = options?.type
      ? this.resolveMemoryNamespace(userId, options.type)
      : [STORE_NAMESPACES.MEMORIES, userId];

    return this.store.search(namespace, { query, limit });
  }

  /**
   * 列出指定用户和类型下的所有记忆
   *
   * @param userId - 用户标识
   * @param type - 记忆类型（可选，不传则列出所有类型）
   * @param options - 分页选项
   * @returns 记忆列表
   */
  async listMemories(
    userId: string,
    type?: MemoryType,
    options?: { limit?: number; offset?: number },
  ) {
    const namespace = type
      ? this.resolveMemoryNamespace(userId, type)
      : [STORE_NAMESPACES.MEMORIES, userId];

    return this.store.search(namespace, {
      // 单页最大返回记忆数，默认 20 条
      limit: options?.limit ?? 20,
      //偏移量， 默认从第 0 条开始，表示从第一条记忆开始返回
      offset: options?.offset ?? 0,
    });
  }

  /**
   * 删除指定记忆
   *
   * @param userId - 用户标识
   * @param type - 记忆类型
   * @param key - 记忆的唯一标识（UUID），用于在 namespace 分组内定位具体记录
   */
  async deleteMemory(
    userId: string,
    type: MemoryType,
    key: string,
  ): Promise<void> {
    const namespace = this.resolveMemoryNamespace(userId, type);
    await this.store.delete(namespace, key);
  }

  // ============================================================
  // 私有方法
  // ============================================================

  /**
   * 解析记忆命名空间路径
   *
   * Store 采用三层寻址：namespace（文件夹路径）→ key（文件名）→ value（文件内容）。
   * 此方法拼接 namespace 路径，用于在 Store 中定位某用户某类型下的记忆分组。
   *
   * @param userId - 用户标识
   * @param type - 记忆类型
   * @returns 命名空间路径，格式 ["memories", userId, memoryType]
   */
  private resolveMemoryNamespace(userId: string, type: MemoryType): string[] {
    return [STORE_NAMESPACES.MEMORIES, userId, type];
  }

  /**
   * 创建带向量搜索的 InMemoryStore（开发/降级场景）
   */
  private createInMemoryStore(config: StoreConfig): InMemoryStore {
    try {
      const embeddings = this.embeddingsFactory.create();
      return new InMemoryStore({
        index: {
          // 向量模型
          embeddings,
          // 向量维度
          dims: config.embeddingDimensions,
        },
      });
    } catch {
      // Embedding 初始化失败时创建不带向量搜索的 Store
      this.logger.warn('Embedding 初始化失败，InMemoryStore 将不支持语义搜索');
      return new InMemoryStore();
    }
  }

  /**
   * 从项目配置中读取 Store 配置
   */
  private getStoreConfig(): StoreConfig {
    return {
      enabled: this.configService.get<boolean>('ai.store.enabled', true),
      embeddingDimensions: this.configService.get<number>(
        'ai.rag.embedding.dimensions',
        1024,
      ),
      memoryTtlSeconds: this.configService.get<number>(
        'ai.store.memoryTtlSeconds',
        0,
      ),
      defaultSearchLimit: this.configService.get<number>(
        'ai.store.defaultSearchLimit',
        5,
      ),
    };
  }

  /**
   * 复用数据库配置构建连接字符串
   */
  private buildConnectionString(): string {
    const host = this.configService.get<string>('database.host', 'localhost');
    const port = this.configService.get<number>('database.port', 5432);
    const user = this.configService.get<string>('database.user', 'postgres');
    const pass = this.configService.get<string>('database.pass', '');
    const name = this.configService.get<string>(
      'database.name',
      'nest_journey',
    );
    return `postgresql://${user}:${encodeURIComponent(pass)}@${host}:${port}/${name}`;
  }
}
