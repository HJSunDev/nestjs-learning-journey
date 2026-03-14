# 045. RAG 检索增强生成 (Retriever & Vector Store)

## 1. 核心问题与概念 (The "Why")

### 解决什么问题

大语言模型的知识止于训练数据的截止日期，且无法访问企业私有数据。当用户询问模型训练数据中不存在的信息时，模型要么拒绝回答，要么生成看似合理但事实错误的内容（幻觉）。

**RAG（Retrieval-Augmented Generation）** 通过在推理前先从外部知识库检索相关信息，将其作为上下文注入 Prompt，让 LLM 基于真实文档生成回答，从根本上解决知识盲区和幻觉问题。

### 核心概念与依赖

| 概念                    | 技术术语            | 作用                                                          |
| ----------------------- | ------------------- | ------------------------------------------------------------- |
| **Embedding**     | 文本向量化          | 将文本映射为高维向量空间中的点，语义相近的文本向量距离更近    |
| **Vector Store**  | 向量数据库          | 专门存储和检索高维向量的数据库，支持 KNN（K-最近邻）搜索      |
| **Text Splitter** | 文本切块器          | 将长文档切分为语义完整的小块，每块作为独立的向量化单元        |
| **Retriever**     | 检索器              | LangChain 的抽象层，封装向量检索逻辑为 LCEL 可组合的 Runnable |
| **pgvector**      | PostgreSQL 向量扩展 | 为 PostgreSQL 添加 `vector` 数据类型和 KNN 索引支持         |

### 关键架构决策

**Embedding 模型与 LLM 完全解耦**：Embedding 模型只负责将文本变成向量用于检索，LLM 只负责基于检索结果生成回答。两者可以来自不同厂商、不同模型。唯一约束是**存和查必须用同一个 Embedding 模型**（向量空间一致性）。

**自实现 PgVectorStore 而非使用 @langchain/community**：`@langchain/community` 存在不可调和的 peer dependency 冲突（详见 EXP-004），且该聚合包质量参差不齐。基于 `@langchain/core` 的 `VectorStore` 基类自行实现，复用已有的 `pg` 驱动，零新集成包依赖。

**复用 SiliconFlow 的 Embedding API**：SiliconFlow 提供 OpenAI 兼容的 `/v1/embeddings` 端点，默认使用 `Qwen/Qwen3-Embedding-8B`（MTEB 排行榜开源第一，4096 维度，32K tokens 上下文）。通过 `@langchain/openai` 的 `OpenAIEmbeddings` + 自定义 `baseURL` 接入。

## 2. 核心用法 / 方案设计 (Usage / Design)

### 场景 A: 文档摄入（构建知识库）

```
POST /ai/lcel/rag/ingest
```

将文本文档切块、向量化后存入 PGVector：

```typescript
// 请求
{
    "documents": [
      {
        "text": "NestJS 是一个用于构建高效、可扩展的 Node.js 服务端应用的框架。它使用 TypeScript 编写，结合了 OOP、FP 和 FRP的元素。NestJS 的核心概念是模块、控制器和服务。模块用于组织应用程序结构，控制器处理 HTTP 请求，服务包含业务逻辑。",
        "metadata": { "source": "docs/nestjs-intro.md", "title": "NestJS 简介" }
      },
      {
        "text": "依赖注入（Dependency Injection）是 NestJS 的核心特性之一。通过 @Injectable() 装饰器声明服务，然后在模块的providers 中注册，NestJS 会自动管理依赖关系。构造函数注入是最常用的方式。",
        "metadata": { "source": "docs/nestjs-di.md", "title": "依赖注入" }
      },
      {
        "text": "TypeORM 是 NestJS 官方推荐的 ORM 框架。通过 @Entity() 定义实体，@Column() 定义字段。支持 Repository模式，可以方便地进行 CRUD 操作。事务管理通过 @Transaction() 装饰器或 DataSource 实现。",
        "metadata": { "source": "docs/typeorm.md", "title": "TypeORM 集成" }
      }
    ],
  "collection": "nestjs-docs",
  "chunkSize": 500,
  "chunkOverlap": 50
}

// 响应（所有接口均通过 TransformInterceptor 统一包装）
{
  "statusCode": 200,
  "message": "success",
  "data": {
    "documentIds": ["uuid-1", "uuid-2", "uuid-3"],
    "chunkCount": 3,
    "collection": "nestjs-docs",
    "message": "成功摄入 1 篇文档，生成 3 个文档块"
  },
  "timestamp": "2026-03-13T10:00:00.000Z"
}
```

### 场景 B: RAG 对话（基于知识库回答）

```
POST /ai/lcel/rag/chat
```

先检索相关文档，再由 LLM 基于上下文生成回答：

```typescript
// 请求
{
  "question": "NestJS 中如何实现模块间共享？",
  "collection": "nestjs-docs",
  "topK": 4,
  "provider": "siliconflow",
  "model": "Pro/MiniMaxAI/MiniMax-M2.5"
}

// 响应
{
  "statusCode": 200,
  "message": "success",
  "data": {
    "content": "在 NestJS 中，模块间共享通过 exports 数组实现...",
    "sources": [
      {
        "content": "NestJS 使用 @Module 装饰器来组织应用结构...",
        "score": 0.15,
        "metadata": { "source": "nestjs-docs.md", "chunkIndex": 0 }
      }
    ],
    "usage": { "promptTokens": 512, "completionTokens": 256, "totalTokens": 768 },
    "finishReason": "stop"
  },
  "timestamp": "2026-03-13T10:00:00.000Z"
}
```

### 场景 C: 相似度搜索（调试检索质量）

```
POST /ai/lcel/rag/search
```

直接对向量数据库检索，不经过 LLM：

```typescript
{
  "query": "依赖注入",
  "topK": 4,
  "collection": "nestjs-docs"
}
```

### 场景 D: 知识库集合管理

```
GET    /ai/lcel/rag/collections              # 列出所有集合
DELETE /ai/lcel/rag/collections/:collection   # 删除指定集合
```

```typescript
// DELETE /ai/lcel/rag/collections/nestjs-docs 响应
{
  "statusCode": 200,
  "message": "success",
  "data": {
    "collection": "nestjs-docs",
    "deletedDocumentCount": 3,
    "message": "集合 nestjs-docs 已清除，共删除 3 个文档块"
  },
  "timestamp": "2026-03-13T10:00:00.000Z"
}
```

## 3. 深度原理与机制 (Under the Hood)

### RAG 全链路数据流

```
[离线阶段 - 文档摄入]
  原始文档
    ↓ RecursiveCharacterTextSplitter（按段落→句子→词递归切分）
  文档块 (Document[])
    ↓ OpenAIEmbeddings (Qwen3-Embedding-8B via SiliconFlow API)
  向量数组 (number[][])
    ↓ PgVectorStore.addVectors()
  PostgreSQL + pgvector（向量 + 元数据持久化）

[在线阶段 - 检索与生成]
  用户提问 "NestJS 如何实现 DI？"
    ↓ OpenAIEmbeddings.embedQuery()
  查询向量 (number[])
    ↓ PgVectorStore.similaritySearchVectorWithScore()
    ↓ SQL: SELECT ... ORDER BY embedding <=> $1::vector LIMIT $2
  相关文档块 + 相似度分数
    ↓ 序列化为文本上下文
  RAG Prompt = System(RAG指令 + {context}) + Human({question})
    ↓ LLM.invoke()
  AI 回答 + 来源引用
```

### 文档切块（Text Splitting）的原理与参数

**为什么必须切块**：Embedding 模型有 token 上限（Qwen3-Embedding-8B 为 32K tokens），但更关键的约束是——**语义精度随文本长度急剧下降**。一篇 5000 字的文章只生成一个向量，该向量只能表示文章的"大致主题"，无法区分其中具体的知识点。用户问"NestJS 如何实现 DI？"时，一个代表整篇文章的向量远不如一个只代表"依赖注入"段落的向量匹配精准。

**RecursiveCharacterTextSplitter 的递归切分策略**：

LangChain 提供多种切块器，`RecursiveCharacterTextSplitter` 是生产中使用最广泛的。它按照分隔符优先级**递归降级**切分：

```
优先级从高到低："\n\n"（段落）→ "\n"（换行）→ " "（空格）→ ""（单字符）

原始文档（2000 字符）
│
├─ 尝试按 "\n\n" 切分 → 得到 3 个段落（800, 700, 500 字符）
│   ├─ 段落 1（800 字符）> chunkSize(500) → 继续递归
│   │   └─ 按 "\n" 切分 → 得到 2 个块（450, 350）✓ 都 ≤ 500
│   ├─ 段落 2（700 字符）> chunkSize(500) → 继续递归
│   │   └─ 按 "\n" 切分 → 得到 2 个块（400, 300）✓
│   └─ 段落 3（500 字符）≤ chunkSize ✓ 直接作为一个块
```

**核心思想**：尽可能在语义边界（段落、句子）处切分，而不是在词语中间硬截断。这样每个块都保持语义完整性。

**两个关键参数**：

```
chunkSize = 500, chunkOverlap = 50 时：

原始文档：[=================块A=================][=====重叠=====][================块B=================]
                     500 字符                    ← 50 字符 →              500 字符
```

| 参数             | 含义                             | 默认值 | 影响                                                                 |
| ---------------- | -------------------------------- | ------ | -------------------------------------------------------------------- |
| `chunkSize`    | 每个文档块的**最大字符数** | 500    | 越小 → 检索越精准但丢失上下文；越大 → 保留更多上下文但检索噪声增加 |
| `chunkOverlap` | 相邻块之间的**重叠字符数** | 50     | 防止关键信息恰好被切断在两个块的边界上。重叠区域让相邻块共享一段文本 |

**`chunkOverlap` 存在的原因**：假设一段关键信息"NestJS 使用 @Injectable 装饰器声明服务，然后在模块的 providers 中注册"恰好跨越了块 A 和块 B 的边界。如果没有重叠，块 A 只有前半句，块 B 只有后半句，两个块单独检索时语义都不完整。重叠 50 个字符后，块 B 的开头会包含块 A 结尾的 50 个字符，确保这段信息至少在一个块中是完整的。

**生产最佳实践**：

| 文档类型            | 推荐 chunkSize | 推荐 chunkOverlap | 理由                                                                    |
| ------------------- | -------------- | ----------------- | ----------------------------------------------------------------------- |
| 技术文档 / API 文档 | 300-500        | 50-100            | 知识点密度高，小块精准命中                                              |
| 叙述性文档 / 教程   | 800-1000       | 100-200           | 需要保留上下文连贯性                                                    |
| 法律/合同文本       | 1000-1500      | 200-300           | 条款通常较长，不宜拆散                                                  |
| 代码文件            | 按函数/类切分  | -                 | 应使用 `RecursiveCharacterTextSplitter.fromLanguage()` 按语法结构切分 |

**通用经验**：`chunkOverlap` 一般设为 `chunkSize` 的 10%-20%。过大的重叠会导致大量重复内容占用存储和检索资源，过小则容易丢失跨块信息。

### 自实现 PgVectorStore 的核心设计

继承 `@langchain/core` 的 `VectorStore` 抽象基类，只需实现 3 个方法：

| 方法                                  | 职责           | 实现要点                                                 |
| ------------------------------------- | -------------- | -------------------------------------------------------- |
| `_vectorstoreType()`                | 返回类型标识   | 返回 `'pgvector'`                                      |
| `addVectors()`                      | 存入向量和文档 | INSERT + ON CONFLICT UPSERT，事务保护，前置向量校验      |
| `similaritySearchVectorWithScore()` | 向量相似度检索 | 根据 `distanceStrategy` 使用对应的 pgvector 距离运算符 |

基类自动基于这些方法派生出：

- `addDocuments()` — 先 embed 再 addVectors
- `similaritySearch()` / `similaritySearchWithScore()` — 先 embedQuery 再 similaritySearchVectorWithScore
- `asRetriever()` — 包装为 LangChain Retriever

### pg 驱动的 `client.query()` / `pool.query()`

`pg`（node-postgres）是 Node.js 连接 PostgreSQL 的底层驱动。它的核心 API 只有一个方法：`query()`。这个名字容易造成误解——它**不是只能做查询（SELECT）**，而是**执行任意 SQL 语句**的通用方法。

```typescript
// query() 是 "执行 SQL" 的意思，不是 "查询" 的意思
await client.query('CREATE TABLE ...');          // DDL：创建表
await client.query('INSERT INTO ...');           // DML：插入数据
await client.query('UPDATE ... SET ...');        // DML：更新数据
await client.query('DELETE FROM ...');           // DML：删除数据
await client.query('SELECT ...');                // DQL：查询数据
await client.query('CREATE INDEX ...');          // DDL：创建索引
await client.query('BEGIN');                     // TCL：开启事务
await client.query('COMMIT');                    // TCL：提交事务
```

**`pool.query()` 与 `client.query()` 的区别**：

| 方式                                                                               | 获取方式 | 连接管理                                              | 适用场景                                        |
| ---------------------------------------------------------------------------------- | -------- | ----------------------------------------------------- | ----------------------------------------------- |
| `pool.query(sql)`                                                                | 直接调用 | 自动从连接池借出、执行、归还                          | 单条独立 SQL                                    |
| `client = await pool.connect()` → `client.query(sql)` → `client.release()` | 手动获取 | 手动借出和归还，同一 client 上的多条 SQL 共享一个连接 | **事务**（BEGIN/COMMIT 必须在同一连接上） |

PgVectorStore 中两种方式都有使用：

- `addVectors()` 使用 `client = pool.connect()` → 因为事务（BEGIN/COMMIT/ROLLBACK）必须在同一个数据库连接上执行，跨连接的事务无效
- `similaritySearchVectorWithScore()` 使用 `pool.query()` → 单条 SELECT，无需事务，让连接池自动管理

**参数化查询（防 SQL 注入）**：`query()` 的第二个参数接收参数数组，用 `$1`, `$2` 等占位符引用，由 PostgreSQL 引擎做参数绑定，从根本上杜绝 SQL 注入：

```typescript
// ✅ 参数化查询：值通过 $N 占位符传入，由 PG 引擎绑定
await pool.query(
  'SELECT * FROM users WHERE id = $1 AND name = $2',
  [userId, userName]
);

// ❌ 字符串拼接：有 SQL 注入风险
await pool.query(`SELECT * FROM users WHERE id = '${userId}'`);
```

**返回值 `QueryResult<T>`**：`query()` 返回的不是原始数据，而是一个结构化对象：

- `result.rows` — 查询结果行数组（SELECT 时有值）
- `result.rowCount` — 受影响的行数（INSERT/UPDATE/DELETE 时有值）
- `result.fields` — 列元数据（列名、类型 OID 等）

通过泛型 `pool.query<T>(sql)` 可以为 `rows` 指定类型，避免 `any` 传播。

### 相似度检索的原理

Embedding 模型将文本映射为高维空间中的向量（如 1024 维的浮点数数组）。语义相近的文本在向量空间中距离更近。"检索"本质上是：**把用户的查询文本也变成向量，然后在向量空间中找到与它距离最近的 K 个已存储的文档向量**，即 KNN（K-Nearest Neighbors）问题。

**余弦相似度（Cosine Similarity）** 是文本检索场景的生产标准方案：

```
                  A · B           Σ(Ai × Bi)
cos(θ) = ─────────────── = ───────────────────────
              ‖A‖ × ‖B‖     √Σ(Ai²) × √Σ(Bi²)
```

它度量的是两个向量的**方向**是否一致，而非大小。值域为 `[-1, 1]`，1 表示方向完全一致（语义相同），0 表示正交（无关），-1 表示完全相反。pgvector 的 `<=>` 运算符返回的是**余弦距离**（= 1 - 余弦相似度），值域 `[0, 2]`，越小越相似。

**为什么余弦距离是文本检索的最佳选择**：不同文档的文本长度差异巨大，Embedding 模型生成的向量范数（长度）也不同。余弦距离只看方向不看长度，避免了"长文档向量范数大 → 与任何查询的欧氏距离都大 → 永远检索不到"的问题。这是业界 RAG 系统（包括 OpenAI、Pinecone、Weaviate 等）的默认策略。

### pgvector 距离运算符

| 度量                   | 运算符  | 数学公式      | 适用场景                                   |
| ---------------------- | ------- | ------------- | ------------------------------------------ |
| 余弦距离 (cosine)      | `<=>` | 1 - cos(θ)   | **生产默认**，对文本长度不敏感       |
| 欧氏距离 (euclidean)   | `<->` | √Σ(Ai-Bi)² | 向量已归一化且需要绝对距离时               |
| 负内积 (inner product) | `<#>` | -Σ(Ai×Bi)   | 向量已归一化时的高效替代（等价于余弦距离） |

**生产最佳实践**：绝大多数文本 RAG 场景使用余弦距离即可。只有在明确知道向量已 L2 归一化（范数为 1）的情况下，内积才有意义（此时余弦距离 = 欧氏距离 = 内积的单调变换，三者检索结果完全一致，内积计算量最小）。

### HNSW 索引

使用 HNSW（Hierarchical Navigable Small World）索引加速检索：

- 相比 IVFFlat 索引，HNSW 在查询速度和召回率之间有更好的平衡
- 支持增量插入，无需重建索引
- 索引运算类根据 `distanceStrategy` 动态选择（`vector_cosine_ops` / `vector_l2_ops` / `vector_ip_ops`），确保索引与查询运算符匹配，否则 PostgreSQL 无法命中索引

### Embedding 模型选型对比

| 模型                          | MTEB 评分       | 维度           | 上下文        | 价格                      |
| ----------------------------- | --------------- | -------------- | ------------- | ------------------------- |
| **Qwen3-Embedding-8B**  | **70.58** | **4096** | **32K** | **¥0.28/M tokens** |
| BAAI/bge-m3                   | 63.0            | 1024           | 8K            | 免费                      |
| OpenAI text-embedding-3-large | 64.6            | 3072           | 8K            | $0.13/M tokens            |
| Cohere embed-v4               | 65.2            | 1024           | -             | $0.10/M tokens            |

项目默认使用 Qwen3-Embedding-8B。

### 向量维度的权衡：为什么默认 4096 但配置 1024

Qwen3-Embedding-8B 原生输出维度为 4096，但通过 API 参数 `dimensions` 可请求降维到 32~4096 的任意值。降维使用 **MRL（Matryoshka Representation Learning）** 技术，模型在训练阶段就学习了"前 N 维包含最重要信息"的表示方式，因此截断前 1024 维不是粗暴丢弃，而是保留了最高信息密度的部分。

项目配置 `AI_EMBEDDING_DIMENSIONS=1024` 的具体权衡：

| 维度           | 存储/条       | 索引内存         | 检索速度        | MTEB 精度损失 |
| -------------- | ------------- | ---------------- | --------------- | ------------- |
| 4096           | 16KB          | 基准             | 基准            | 0%            |
| **1024** | **4KB** | **约 1/4** | **约 4x** | **<2%** |
| 256            | 1KB           | 约 1/16          | 约 16x          | ~5-8%         |

1024 维时精度损失不到 2%，但存储和检索速度提升 4 倍。对于知识库规模在百万级文档块以下的场景，1024 维是业界公认的最佳平衡点。这就是配置文件中 `AI_EMBEDDING_DIMENSIONS` 默认值为 1024 而非模型原生 4096 的原因。

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

### ✅ 推荐做法

- **向量维度取舍**：Qwen3-Embedding-8B 支持 32~4096 可变维度。生产环境建议 1024（精度与存储/速度的最佳平衡点），而非默认的 4096
- **切块大小调优**：默认 500 字符 + 50 字符重叠。对于技术文档，较小的 chunk（300-500）检索精度更高；对于叙述性文档，较大的 chunk（800-1000）保留更多上下文
- **集合隔离**：不同领域的知识库使用不同 collection，避免跨领域检索产生噪声
- **元数据追踪**：为每个文档块注入 source、title 等元数据，便于回答时引用来源
- **防御性编程**：PgVectorStore 实施了三层防御——构造阶段校验表名合法性（正则白名单，防 SQL 注入），插入阶段校验向量维度和值（拦截 NaN/Infinity），初始化阶段根据 distanceStrategy 动态匹配 HNSW 索引运算类

### ❌ 避免做法

- **混用 Embedding 模型**：同一个 collection 内必须使用相同的 Embedding 模型，否则向量空间不一致，检索失效
- **过大的 chunkSize**：超过 Embedding 模型的 token 上限会导致截断，信息丢失
- **忽略检索质量调试**：上线前必须使用 `/rag/search` 端点验证检索结果的相关性，检索质量决定了 RAG 系统的上限
- **直接引入 @langchain/community**：该聚合包存在严重的 peer dependency 冲突，应基于 @langchain/core 基类自行实现（详见 EXP-004）

## 5. 行动导向 (Action Guide)

### Step 1: Docker 镜像切换

**这一步在干什么**：将 PostgreSQL 容器镜像从 `postgres:16` 切换为 `pgvector/pgvector:pg16`，获得 pgvector 向量扩展支持。

**两个镜像的区别**：

| 对比项     | `postgres:16`             | `pgvector/pgvector:pg16`                   |
| ---------- | --------------------------- | -------------------------------------------- |
| 维护方     | PostgreSQL 官方 Docker 团队 | pgvector 社区                                |
| 基础       | 纯净的 PostgreSQL 16        | 基于 `postgres:16` 构建                    |
| 区别       | 无 vector 扩展              | **预装了 pgvector 扩展**（.so 共享库） |
| 大小差异   | ~430MB                      | ~435MB（仅多约 5MB）                         |
| SQL 兼容性 | 完全标准                    | 完全标准 + 额外的 `vector` 类型            |

**对现有模块的影响**：**零影响**。`pgvector/pgvector:pg16` 的 Dockerfile 仅在官方 `postgres:16` 基础上编译安装了 pgvector 扩展库（`.so` 文件），PostgreSQL 引擎本身完全相同。所有现有的表结构、数据、索引、SQL 查询行为都不会改变。`vector` 扩展只有在执行 `CREATE EXTENSION vector` 后才会激活，不影响不使用它的模块（如 User、Auth 等）。

```yaml
# docker-compose.yml
services:
  postgres:
    image: pgvector/pgvector:pg16  # 替换 postgres:16
    # 其余配置不变
```

如果当前有运行中的容器，需要先停止并重新拉取镜像：

```bash
npm run docker:down
docker pull pgvector/pgvector:pg16
npm run docker:db
```

### Step 2: 安装依赖

**这一步在干什么**：安装 RAG 链路所需的两个 LangChain 包。`@langchain/openai` 提供 `OpenAIEmbeddings` 类用于对接 SiliconFlow 的 Embedding API；`@langchain/textsplitters` 提供 `RecursiveCharacterTextSplitter` 用于文档切块。

```bash
npm install @langchain/openai @langchain/textsplitters
```

不需要 `@langchain/community`——向量存储基于 `@langchain/core` 的 `VectorStore` 基类自行实现。

### Step 3: 环境变量配置

**这一步在干什么**：在 `.env` 中添加 RAG 相关的可选配置项。所有配置均有合理的默认值，开箱即用无需额外配置。

```bash
# .env（可选配置，均有默认值）
# AI_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-8B
# AI_EMBEDDING_DIMENSIONS=1024
# AI_RAG_CHUNK_SIZE=500
# AI_RAG_CHUNK_OVERLAP=50
# AI_RAG_TOP_K=4
# AI_RAG_TABLE_NAME=langchain_documents
```

### Step 4: 核心模块文件

**这一步在干什么**：创建 `src/ai/rag/` 目录，包含 4 个核心文件。每个文件的职责边界清晰，遵循 SRP 原则。

```
src/ai/rag/
├── index.ts                    # Barrel 导出
├── embeddings.factory.ts       # Embedding 模型工厂
├── pg-vector-store.ts          # 自实现的 PGVector 向量存储
├── vector-store.service.ts     # NestJS 生命周期管理服务
└── document.processor.ts       # 文档切块处理器
```

**embeddings.factory.ts** — 创建 OpenAIEmbeddings 实例，通过 `configuration.baseURL` 指向 SiliconFlow。每个配置项使用 `configService.get<T>()` 显式泛型，避免 `any` 传播：

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIEmbeddings } from '@langchain/openai';

@Injectable()
export class EmbeddingsFactory {
  constructor(private readonly configService: ConfigService) {}

  create(options?: { model?: string; dimensions?: number }): OpenAIEmbeddings {
    const defaultProvider = this.configService.get<string>('ai.defaultProvider', 'siliconflow');
    const apiKey = this.configService.get<string>(`ai.providers.${defaultProvider}.apiKey`);
    const baseURL = this.configService.get<string>(`ai.providers.${defaultProvider}.baseUrl`);
    const model = options?.model || this.configService.get<string>('ai.rag.embedding.model');
    const dimensions = options?.dimensions || this.configService.get<number>('ai.rag.embedding.dimensions');

    return new OpenAIEmbeddings({
      model, dimensions, apiKey,
      configuration: { baseURL },
    });
  }
}
```

**pg-vector-store.ts** — 继承 `VectorStore` 基类，实现 3 个抽象方法：

```typescript
import { VectorStore } from '@langchain/core/vectorstores';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import type { DocumentInterface } from '@langchain/core/documents';
import type { Pool } from 'pg';

export class PgVectorStore extends VectorStore {
  _vectorstoreType(): string { return 'pgvector'; }

  async addVectors(vectors: number[][], documents: DocumentInterface[]): Promise<string[]> {
    // INSERT INTO langchain_documents (id, content, metadata, embedding, collection) VALUES (...)
  }

  async addDocuments(documents: DocumentInterface[]): Promise<string[]> {
    const vectors = await this.embeddings.embedDocuments(texts);
    return this.addVectors(vectors, documents);
  }

  async similaritySearchVectorWithScore(query: number[], k: number): Promise<[DocumentInterface, number][]> {
    // SELECT ... ORDER BY embedding <=> $1::vector LIMIT $2
  }
}
```

### Step 5: 注册 Provider

**这一步在干什么**：在 `ai.module.ts` 中注册三个新的 Provider，使其可通过 NestJS DI 注入到 Service 层。

```typescript
// ai.module.ts
import { EmbeddingsFactory, VectorStoreService, DocumentProcessor } from './rag';

@Module({
  providers: [
    // ...existing providers
    EmbeddingsFactory,
    VectorStoreService,
    DocumentProcessor,
  ],
  exports: [
    // ...existing exports
    EmbeddingsFactory,
    VectorStoreService,
    DocumentProcessor,
  ],
})
export class AiModule {}
```

### Step 6: 验证

**这一步在干什么**：启动服务后，通过 Swagger UI 依次测试摄入、检索、对话三个核心端点。

```bash
# 1. 确保数据库容器使用 pgvector 镜像
npm run docker:db

# 2. 启动开发服务器
npm run dev

# 3. 打开 Swagger UI
# http://localhost:3000/api-docs

# 4. 测试文档摄入
# POST /ai/lcel/rag/ingest

# 5. 测试相似度搜索
# POST /ai/lcel/rag/search

# 6. 测试 RAG 对话
# POST /ai/lcel/rag/chat
```

---

## 6. ApiPost 测试接口参数

以下参数可直接复制到 ApiPost 中使用，按顺序测试完整 RAG 链路。

### 6.1 文档摄入

```
POST /ai/lcel/rag/ingest
```

```json
{
  "documents": [
    {
      "text": "NestJS 是一个用于构建高效、可扩展的 Node.js 服务端应用的框架。它使用 TypeScript 编写，结合了 OOP、FP 和 FRP 的元素。NestJS 的核心概念是模块、控制器和服务。模块用于组织应用程序结构，控制器处理 HTTP 请求，服务包含业务逻辑。",
      "metadata": { "source": "docs/nestjs-intro.md", "title": "NestJS 简介" }
    },
    {
      "text": "依赖注入（Dependency Injection）是 NestJS 的核心特性之一。通过 @Injectable() 装饰器声明服务，然后在模块的 providers 中注册，NestJS 会自动管理依赖关系。构造函数注入是最常用的方式。",
      "metadata": { "source": "docs/nestjs-di.md", "title": "依赖注入" }
    },
    {
      "text": "TypeORM 是 NestJS 官方推荐的 ORM 框架。通过 @Entity() 定义实体，@Column() 定义字段。支持 Repository 模式，可以方便地进行 CRUD 操作。事务管理通过 @Transaction() 装饰器或 DataSource 实现。",
      "metadata": { "source": "docs/typeorm.md", "title": "TypeORM 集成" }
    }
  ],
  "collection": "nestjs-docs",
  "chunkSize": 500,
  "chunkOverlap": 50
}
```

### 6.2 RAG 对话

```
POST /ai/lcel/rag/chat
```

```json
{
  "question": "NestJS 中如何实现依赖注入？",
  "provider": "siliconflow",
  "model": "Pro/MiniMaxAI/MiniMax-M2.5",
  "collection": "nestjs-docs",
  "topK": 4,
  "temperature": 0.7
}
```

### 6.3 流式 RAG 对话

```
POST /ai/lcel/rag/chat/stream
```

```json
{
  "question": "TypeORM 如何处理事务？",
  "provider": "siliconflow",
  "model": "Pro/MiniMaxAI/MiniMax-M2.5",
  "collection": "nestjs-docs",
  "topK": 3
}
```

### 6.4 相似度搜索

```
POST /ai/lcel/rag/search
```

```json
{
  "query": "依赖注入",
  "topK": 5,
  "collection": "nestjs-docs"
}
```

### 6.5 列出所有知识库集合

```
GET /ai/lcel/rag/collections
```

无请求体。

### 6.6 删除指定集合

```
DELETE /ai/lcel/rag/collections/nestjs-docs
```

无请求体，集合名在 URL 路径中。

### 测试顺序建议

1. 先调用 `POST /rag/ingest` 摄入文档
2. 调用 `GET /rag/collections` 确认集合已创建
3. 调用 `POST /rag/search` 测试检索效果
4. 调用 `POST /rag/chat` 测试 RAG 对话
5. 调用 `DELETE /rag/collections/:collection` 清理测试数据
