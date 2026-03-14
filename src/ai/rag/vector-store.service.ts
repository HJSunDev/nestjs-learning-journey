import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PgVectorStore } from './pg-vector-store';
import { EmbeddingsFactory } from './embeddings.factory';

/**
 * 向量存储服务
 *
 * 管理 PgVectorStore 的完整生命周期：
 * 1. 模块初始化时创建 pg 连接池和向量表
 * 2. 运行时提供 PgVectorStore 实例供 RAG 链使用
 * 3. 模块销毁时释放连接池
 *
 * 设计决策：
 * - 使用独立的 pg.Pool 而非 TypeORM 的连接，因为 TypeORM 不原生支持 pgvector 类型
 * - 连接池在模块初始化时创建，确保向量表在应用启动时就绑定
 * - PgVectorStore 实例懒创建（首次调用 getStore() 时），避免阻塞启动
 */
@Injectable()
export class VectorStoreService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VectorStoreService.name);
  private pool: Pool;
  private store: PgVectorStore;

  constructor(
    private readonly configService: ConfigService,
    private readonly embeddingsFactory: EmbeddingsFactory,
  ) {}

  async onModuleInit(): Promise<void> {
    // 创建 pg 连接池
    this.pool = new Pool({
      host: this.configService.get<string>('database.host'),
      port: this.configService.get<number>('database.port'),
      user: this.configService.get<string>('database.user'),
      password: this.configService.get<string>('database.pass'),
      database: this.configService.get<string>('database.name'),
      max: 5,
    });

    this.logger.log('PgVector 连接池已创建');

    try {
      await this.initializeStore();
      this.logger.log('向量存储初始化完成');
    } catch (error) {
      this.logger.error('向量存储初始化失败', error);
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.logger.log('PgVector 连接池已关闭');
    }
  }

  /**
   * 获取 PgVectorStore 实例
   *
   * 作为 RAG 链路中向量检索和文档存储的核心组件。
   * 返回的实例可直接调用 .asRetriever() 转为 LangChain Retriever。
   */
  getStore(): PgVectorStore {
    if (!this.store) {
      throw new Error('VectorStore 尚未初始化，请确保模块已启动');
    }
    return this.store;
  }

  /**
   * 初始化向量存储：创建 Embedding 实例 → PgVectorStore → 确保表结构存在
   */
  private async initializeStore(): Promise<void> {
    // 创建 Embedding模型实例，默认使用 SiliconFlow 的 Qwen3-Embedding-8B 模型
    const embeddings = this.embeddingsFactory.create();

    // 创建 PgVectorStore 实例，把 Embedding 模型实例和 PgVectorStore 配置传入
    this.store = new PgVectorStore(embeddings, {
      pool: this.pool,
      // tableName: 向量存储表名
      tableName: this.configService.get<string>('ai.rag.tableName'),
      // dimensions: 向量维度
      dimensions: this.configService.get<number>(
        'ai.rag.embedding.dimensions',
      )!,
    });

    // 确保向量表存在：创建 pgvector 扩展、建表、建索引（幂等操作）
    await this.store.ensureTableExists();
  }
}
