import { VectorStore } from '@langchain/core/vectorstores';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import type { DocumentInterface } from '@langchain/core/documents';
import type { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

/**
 * PgVectorStore 初始化配置
 */
export interface PgVectorStoreConfig {
  /** pg 连接池实例（复用已有的 pg.Pool） */
  pool: Pool;
  /** 向量存储表名 */
  tableName?: string;
  /** 向量维度（必须与 Embedding 模型输出维度一致） */
  dimensions: number;
  /** 距离度量策略 */
  distanceStrategy?: 'cosine' | 'euclidean' | 'innerProduct';
}

/**
 * 距离运算符映射
 *
 * pgvector 对不同度量使用不同的运算符：
 * - cosine: <=> (余弦距离，值域 [0,2]，0 表示完全相同)
 * - euclidean: <-> (欧氏距离)
 * - innerProduct: <#> (负内积，取负后越大越相似)
 */
const DISTANCE_OPERATORS: Record<string, string> = {
  cosine: '<=>',
  euclidean: '<->',
  innerProduct: '<#>',
};

/**
 * HNSW 索引运算类映射
 *
 * 索引运算类必须与查询时使用的距离运算符匹配，否则 PostgreSQL 无法命中索引。
 */
const INDEX_OPS: Record<string, string> = {
  cosine: 'vector_cosine_ops',
  euclidean: 'vector_l2_ops',
  innerProduct: 'vector_ip_ops',
};

/** 合法表名格式：字母或下划线开头，后接字母、数字、下划线 */
const TABLE_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * 自实现的 PGVector 向量存储
 *
 * 继承 @langchain/core 的 VectorStore 基类，使用已有的 pg 驱动操作 PostgreSQL + pgvector。
 * 遵循 EXP-004 策略：不引入 @langchain/community，基于 core 基类自实现。
 *
 * 设计决策：
 * - 复用项目已有的 pg.Pool，不创建新连接
 * - 使用 JSONB 存储 metadata，支持灵活的元数据过滤
 * - collection 字段实现命名空间隔离，不同知识库互不干扰
 * - 自动管理 pgvector 扩展和表结构的创建
 *
 * 表结构：
 * | 列名       | 类型              | 用途                     |
 * |-----------|-------------------|--------------------------|
 * | id        | UUID              | 文档唯一标识              |
 * | content   | TEXT              | 原始文档文本              |
 * | metadata  | JSONB             | 文档元数据（来源、页码等） |
 * | embedding | vector(N)         | 向量表示                  |
 * | collection| VARCHAR(255)      | 知识库命名空间            |
 */
export class PgVectorStore extends VectorStore {
  declare FilterType: Record<string, unknown>;

  private readonly pool: Pool;
  private readonly tableName: string;
  private readonly dimensions: number;
  private readonly distanceStrategy: string;

  constructor(embeddings: EmbeddingsInterface, config: PgVectorStoreConfig) {
    super(embeddings, config);

    const tableName = config.tableName || 'langchain_documents';
    if (!TABLE_NAME_REGEX.test(tableName)) {
      throw new Error(
        `非法表名 "${tableName}"：仅允许字母、数字、下划线，且不能以数字开头`,
      );
    }

    this.pool = config.pool;
    this.tableName = tableName;
    this.dimensions = config.dimensions;
    this.distanceStrategy = config.distanceStrategy || 'cosine';
  }

  _vectorstoreType(): string {
    return 'pgvector';
  }

  /**
   * 初始化数据库：创建 pgvector 扩展和向量表
   *
   * 使用 IF NOT EXISTS 保证幂等性，重复调用不会报错。
   * 在 NestJS 模块初始化阶段调用一次。
   */
  async ensureTableExists(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          content TEXT NOT NULL,
          metadata JSONB DEFAULT '{}',
          embedding vector(${this.dimensions}),
          collection VARCHAR(255) DEFAULT 'default'
        )
      `);
      // HNSW 索引运算类必须与查询距离运算符匹配，否则退化为全表扫描
      const indexOps = INDEX_OPS[this.distanceStrategy] || 'vector_cosine_ops';
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_${this.tableName}_embedding
        ON ${this.tableName}
        USING hnsw (embedding ${indexOps})
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_${this.tableName}_collection
        ON ${this.tableName} (collection)
      `);
    } finally {
      client.release();
    }
  }

  /**
   * 将预计算的向量和对应文档写入数据库
   *
   * @param vectors 向量数组（与 documents 一一对应）
   * @param documents 文档数组
   * @param options 可选参数，支持 ids 和 collection
   * @returns 插入的文档 ID 数组
   */
  async addVectors(
    vectors: number[][],
    documents: DocumentInterface[],
    options?: { ids?: string[]; collection?: string },
  ): Promise<string[]> {
    const ids = options?.ids || documents.map(() => uuidv4());
    const collection = options?.collection || 'default';

    for (const vector of vectors) {
      this.validateVector(vector);
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (let i = 0; i < documents.length; i++) {
        const vectorStr = `[${vectors[i].join(',')}]`;
        await client.query(
          `INSERT INTO ${this.tableName} (id, content, metadata, embedding, collection)
           VALUES ($1, $2, $3, $4::vector, $5)
           ON CONFLICT (id) DO UPDATE SET
             content = EXCLUDED.content,
             metadata = EXCLUDED.metadata,
             embedding = EXCLUDED.embedding,
             collection = EXCLUDED.collection`,
          [
            ids[i],
            documents[i].pageContent,
            JSON.stringify(documents[i].metadata || {}),
            vectorStr,
            collection,
          ],
        );
      }

      await client.query('COMMIT');
      return ids;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 嵌入文档并写入数据库
   *
   * 先通过 embeddings 实例将文档文本向量化，再调用 addVectors 存入。
   */
  async addDocuments(
    documents: DocumentInterface[],
    options?: { ids?: string[]; collection?: string },
  ): Promise<string[]> {
    const texts = documents.map((doc) => doc.pageContent);
    const vectors = await this.embeddings.embedDocuments(texts);
    return this.addVectors(vectors, documents, options);
  }

  /**
   * 基于向量的相似度检索（核心抽象方法实现）
   *
   * 使用 pgvector 的距离运算符进行 KNN 检索。
   * 支持通过 filter.collection 限定检索范围。
   *
   * @param query 查询向量
   * @param k 返回的文档数量
   * @param filter 可选过滤条件
   * @returns [文档, 相似度分数] 的元组数组，分数越小越相似
   */
  async similaritySearchVectorWithScore(
    query: number[],
    k: number,
    filter?: this['FilterType'],
  ): Promise<[DocumentInterface, number][]> {
    const operator = DISTANCE_OPERATORS[this.distanceStrategy] || '<=>';
    const vectorStr = `[${query.join(',')}]`;

    const conditions: string[] = [];
    const params: unknown[] = [vectorStr, k];

    if (filter?.collection) {
      conditions.push(`collection = $${params.length + 1}`);
      params.push(filter.collection);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await this.pool.query<{
      id: string;
      content: string;
      metadata: Record<string, unknown>;
      distance: number;
    }>(
      `SELECT id, content, metadata, embedding ${operator} $1::vector AS distance
       FROM ${this.tableName}
       ${whereClause}
       ORDER BY distance ASC
       LIMIT $2`,
      params,
    );

    return result.rows.map((row) => [
      {
        pageContent: row.content,
        metadata: {
          ...row.metadata,
          id: row.id,
        },
      },
      row.distance,
    ]);
  }

  /**
   * 删除文档
   *
   * @param params 删除条件，支持 ids（按 ID 删除）和 collection（按集合删除）
   */
  async delete(params: { ids?: string[]; collection?: string }): Promise<void> {
    if (params.ids?.length) {
      await this.pool.query(
        `DELETE FROM ${this.tableName} WHERE id = ANY($1::uuid[])`,
        [params.ids],
      );
    } else if (params.collection) {
      await this.pool.query(
        `DELETE FROM ${this.tableName} WHERE collection = $1`,
        [params.collection],
      );
    }
  }

  /**
   * 获取指定集合的文档数量
   */
  async getDocumentCount(collection?: string): Promise<number> {
    const query = collection
      ? {
          text: `SELECT COUNT(*) FROM ${this.tableName} WHERE collection = $1`,
          values: [collection],
        }
      : { text: `SELECT COUNT(*) FROM ${this.tableName}` };

    const result = await this.pool.query<{ count: string }>(
      query.text,
      query.values,
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * 列出所有集合及其文档数量
   */
  async listCollections(): Promise<
    { collection: string; documentCount: number }[]
  > {
    const result = await this.pool.query<{
      collection: string;
      count: string;
    }>(
      `SELECT collection, COUNT(*) as count
       FROM ${this.tableName}
       GROUP BY collection
       ORDER BY collection`,
    );

    return result.rows.map((row) => ({
      collection: row.collection,
      documentCount: parseInt(row.count, 10),
    }));
  }

  /**
   * 校验向量合法性
   *
   * Embedding 模型在异常情况下可能返回 NaN/Infinity，
   * 直接传入 PostgreSQL 会触发底层 SQL 错误且难以定位根因。
   */
  private validateVector(vector: number[]): void {
    if (!Array.isArray(vector) || vector.length !== this.dimensions) {
      throw new Error(
        `向量维度不匹配：期望 ${this.dimensions}，实际 ${Array.isArray(vector) ? vector.length : 'N/A'}`,
      );
    }
    if (vector.some((v) => !Number.isFinite(v))) {
      throw new Error(
        '向量包含非法值（NaN 或 Infinity），请检查 Embedding 模型输出',
      );
    }
  }
}
