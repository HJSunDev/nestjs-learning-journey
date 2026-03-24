# 052. 记忆体系与运行时扩展 (Memory & Runtime Extensibility)

## 1. 核心问题与概念 (The "Why")

### 解决什么问题

前序章节（044）通过 Redis + `RunnableWithMessageHistory` 实现了 **短期记忆**（Thread 级对话历史），但存在两个关键缺陷：

1. **记忆范围受限于单个 Thread**：用户在线程 A 中告知"我喜欢暗色主题"，切换到线程 B 后 Agent 完全不知道这个偏好。短期记忆是 Thread-scoped 的，无法跨线程传递。
2. **能力扩展需要重新部署**：Agent 的行为完全由部署时的代码和系统提示词决定。添加新的领域知识或操作流程需要修改代码 → 重新构建 → 重新部署。

本章引入三个生产级模式来解决这些问题：


| 模式                     | 解决的问题              | 核心机制                       |
| ---------------------- | ------------------ | -------------------------- |
| **Store 长期记忆**         | 跨线程记忆共享            | `BaseStore` 持久化键值存储 + 语义搜索 |
| **Lane Queue**         | 并发 checkpoint 写入冲突 | Per-thread Promise 链串行化    |
| **Skills-as-Markdown** | 运行时能力扩展            | 文件系统 SKILL.md + 三层渐进式加载     |


### 核心概念与依赖

**什么是 Thread？**

Thread（线程）在本文中指的是 **独立的对话会话**，而非操作系统线程。每个 Thread 有唯一的 `threadId`，代表用户与 Agent 的一次完整对话流程，类似聊天应用中的"对话窗口"。例如：用户打开三个对话窗口分别讨论架构设计、bug 修复、技术学习，每个窗口就是一个独立的 Thread。

**短期 vs 长期记忆的分层架构**：

```
┌──────────────────────────────────────────────┐
│            Agent 记忆分层体系                 │
├──────────────────────────────────────────────┤
│  短期记忆 (Thread-scoped)                     │
│  ├─ Checkpointer (PostgresSaver)             │
│  │   → 单线程内的 State 快照（消息、工具调用）  │
│  └─ ChatHistory (Redis)                      │
│      → 单线程内的对话历史                      │
├──────────────────────────────────────────────┤
│  长期记忆 (Cross-thread)                      │
│  ├─ BaseStore (PostgresStore)                │
│  │   → 跨线程的用户偏好、事实、交互摘要         │
│  └─ 三类记忆分类学                            │
│      ├─ Semantic  (语义记忆)：事实、偏好       │
│      ├─ Episodic  (情景记忆)：对话摘要         │
│      └─ Procedural(程序记忆)：流程、指令       │
└──────────────────────────────────────────────┘
```

**项目中三套"记忆"机制的完整对比**：

本项目在不同章节引入了三套独立的记忆机制，它们解决不同层次的问题，互不替代：


|           | 044 会话记忆           | 049 Checkpoint    | 052 Store（本章）         |
| --------- | ------------------ | ----------------- | --------------------- |
| **存什么**   | 对话消息列表             | 图的完整 State 快照     | 用户偏好、事实、技能            |
| **作用域**   | 单个 Session         | 单个 Thread         | **跨 Thread**          |
| **存储引擎**  | Redis              | PostgreSQL        | PostgreSQL (pgvector) |
| **核心类**   | `RedisChatHistory` | `PostgresSaver`   | `PostgresStore`       |
| **生命周期**  | TTL 过期自动清除         | 随 Thread 存在       | 可配 TTL 或永久            |
| **章节用途**  | 多轮对话上下文            | 断点续传、Time-travel  | 个性化、跨会话记忆             |
| **配置项前缀** | `AI_MEMORY_`*      | `AI_CHECKPOINT_*` | `AI_STORE_*`          |


**具体场景区分**：

- **044 会话记忆**：用户在 **同一对话** 中先说"我叫张三"，后面问"我叫什么"→ 能回答。换一个对话就忘了。
- **049 Checkpoint**：Agent 执行到一半服务崩溃，**重启后从上次断点恢复继续执行**。与"记住用户说了什么"无关。
- **052 Store**：用户在 **对话 A** 中说"我叫张三"，关掉后开了 **对话 B** 问"我叫什么"→ 也能回答。记忆跨越了线程边界。

**LangGraph 双引擎**：

上述三套机制中，049 Checkpoint 和 052 Store 属于 LangGraph 的两个并行引擎：


| 引擎               | 类               | 作用域      | 数据                         |
| ---------------- | --------------- | -------- | -------------------------- |
| **Checkpointer** | `PostgresSaver` | Thread 级 | State 快照（每个 super-step 边界） |
| **Store**        | `PostgresStore` | 跨 Thread | 用户记忆（命名空间隔离）               |


两者在 `graph.compile()` 时分别注入：

```typescript
const graph = builder.compile({
  checkpointer,  // Thread 级状态持久化
  store,         // 跨 Thread 长期记忆
});
```

**命名空间设计**：

Store 通过层级化的命名空间（字符串数组）隔离记忆数据：

```
["memories", userId, memoryType]  → 用户记忆（语义/情景/程序）
```

技能不存储在 Store 中，而是以文件系统中的 SKILL.md 文件存在（见场景 C）。

## 2. 核心用法 / 方案设计 (Usage / Design)

### 场景 A: Store 长期记忆 — 跨线程的用户偏好持久化

**问题**：用户在不同对话线程中告知的偏好/事实需要被记住。

**方案**：

1. `MemoryStoreService` 管理 `PostgresStore` 的生命周期（类比 `CheckpointService` 管理 `PostgresSaver`）
2. Memory Graph 的 `loadMemories` 节点在每次对话前从 Store 语义搜索相关记忆
3. `extractMemories` 节点在 AI 回复后自动提取新的事实并写入 Store

```typescript
// 对话前：搜索相关记忆
const memories = await store.search(
  ["memories", userId],
  { query: "用户偏好什么主题？", limit: 5 }
);

// 对话后：存储新发现的事实
await store.put(
  ["memories", userId, "semantic"],
  crypto.randomUUID(),
  { content: "用户偏好暗色主题", type: "semantic", source: "extracted" }
);
```

### 场景 B: Lane Queue — 防止并发 checkpoint 写入冲突

**问题**：同一 threadId 的两个并发请求同时读取 checkpoint → 各自执行 → 各自写回，后写入的覆盖前者，导致状态丢失。

**方案**：

```typescript
// LaneQueueService 按 threadId 串行化请求
const result = await laneQueueService.enqueue(
  threadId,
  () => graph.invoke(input, config)
);
```

```
Thread-A ──▶ [请求1] ──▶ [请求2] ──▶ [请求3]  （串行执行）
Thread-B ──▶ [请求1] ──▶ [请求2]              （与 Thread-A 并行）
```

### 场景 C: Skills-as-Markdown — 运行时能力扩展

**问题**：添加新的领域知识需要修改代码并重新部署。

**为什么技能不放在数据库里？**

Cursor、Claude Code、LangGraph 社区 —— 所有主流生产级 Agent 都使用文件系统存储技能，遵循 [Agent Skills](https://agentskills.io/) 开放标准：

| 产品 | 技能存储 | 加载方式 | 向量搜索 |
|---|---|---|---|
| **Cursor** | `.cursor/skills/<name>/SKILL.md` | Agent 读取文件 | 否 |
| **Claude Code** | `.claude/skills/<name>/SKILL.md` | 描述匹配 + `/skill-name` | 否 |
| **本项目** | `src/ai/skills/<name>/SKILL.md` | 三层渐进式 tool call | 否 |

原因：技能是**静态的领域知识**，由开发者编写、版本控制、部署时确定。向量搜索适合动态积累的记忆，不适合预定义的静态技能。

**方案 — 三层渐进式加载**：

```
Tier 1 — Catalog（始终在系统提示词中，~500 tokens）
  ├─ 所有技能的 name + description 列表
  └─ 每次请求都携带，供 Agent 判断是否需要加载

Tier 2 — Full Content（按需 tool call）
  ├─ Agent 调用 load_skill(name) 获取完整 SKILL.md 指令
  └─ 首次加载后缓存

Tier 3 — Supporting Files（按需 tool call）
  ├─ Agent 调用 read_skill_file(name, filename) 读取辅助资源
  └─ 如检查清单、示例代码等
```

```
src/ai/skills/                         ← 技能根目录
  code-review/
    SKILL.md                           ← 必需：YAML frontmatter + Markdown 指令
    references/
      checklist.md                     ← 可选：辅助资源
```

```yaml
# SKILL.md 格式
---
name: code-review
description: "代码审查专家技能，关注安全性、性能和代码规范"
tags: [code, review, quality]
---

## Code Review Guidelines
（完整的 Markdown 指令体）
```

**添加新技能**：

在 `src/ai/skills/` 下创建目录 + `SKILL.md` → 调用 `POST /ai/agent/skills/reload` 或重启服务 → 新技能自动可用。无需修改代码。

## 3. 深度原理与机制 (Under the Hood)

### 3.1 Memory Graph 执行流程

```
┌─────────┐     ┌──────────────┐     ┌───────────┐
│  START  │───▶│ loadMemories │───▶│ callModel │
└─────────┘     └──────────────┘     └─────┬─────┘
                                           │
                              ┌────────────┴────────────┐
                              │                         │
                         has tool_calls            no tool_calls
                              │                         │
                              ▼                         ▼
                     ┌──────────────┐      ┌──────────────────┐
                     │ executeTools │      │ extractMemories  │
                     └──────┬───────┘      └────────┬─────────┘
                            │                       │
                            ▼                       ▼
                        callModel                  END
```

**关键节点职责**：


| 节点                | 输入                     | 输出                          | 机制                      |
| ----------------- | ---------------------- | --------------------------- | ----------------------- |
| `loadMemories`    | `state.messages`       | `SystemMessage` + 记忆上下文 + 技能目录 | `store.search()` 语义搜索 + 文件系统目录 |
| `callModel`       | 带记忆上下文的消息              | `AIMessage`                 | 重排消息 + `model.invoke()` |
| `executeTools`    | `AIMessage.tool_calls` | `ToolMessage[]`             | 共享 `executeToolsNode`   |
| `extractMemories` | AI 回复文本                | 清理后的 `AIMessage` + Store 写入 | 正则提取 `<memory_extract>` |


### 3.2 PostgresStore 的向量搜索机制

```
用户输入 "我想改一下代码风格"
         │
         ▼
    Embedding Model
    (Qwen3-Embedding-8B)
         │
         ▼
    向量 [0.12, -0.34, ...]
         │
         ▼
    pgvector 余弦相似度
    SELECT ... ORDER BY embedding <=> $1
         │
         ▼
    匹配结果：
    1. "用户偏好 Prettier 格式化" (score: 0.89)
    2. "项目使用 ESLint + TypeScript" (score: 0.82)
```

PostgresStore 底层通过 pgvector 扩展实现向量索引：

- 索引类型：HNSW（默认，适合大多数场景）或 IVFFlat（适合大数据集）
- 距离度量：余弦相似度（默认）、L2、内积
- 自动建表：`setup()` 幂等执行，创建 `store` 表 + pgvector 索引

### 3.3 Lane Queue 串行化原理

```typescript
// 每个 threadId 维护一条 Promise 链
private readonly lanes = new Map<string, Promise<unknown>>();

async enqueue<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const currentLane = this.lanes.get(threadId) ?? Promise.resolve();

  // 新任务挂到链尾部
  const newLane = currentLane
    .catch(() => {}) // 前序失败不阻塞后续
    .then(() => fn());

  this.lanes.set(threadId, newLane);

  try {
    return await newLane;
  } finally {
    // 清理已完成的 Lane
    if (this.lanes.get(threadId) === newLane) {
      this.lanes.delete(threadId);
    }
  }
}
```

**关键设计**：

- `.catch(() => {})` 确保前序任务失败不阻塞后续任务（各自的 caller 负责异常处理）
- `finally` 块清理已完成的 Lane（防止内存泄漏）
- 不同 threadId 之间完全并行（不同用户不互相阻塞）

### 3.4 记忆提取协议

通过 Prompt Engineering 引导模型在回复末尾输出结构化的记忆提取块：

```xml
<memory_extract>
[
  { "type": "semantic", "content": "用户偏好暗色主题和 Vim 快捷键" },
  { "type": "episodic", "content": "讨论了从 MongoDB 迁移到 PostgreSQL 的方案" }
]
</memory_extract>
```

`extractMemories` 节点通过正则解析此块，写入 Store 后将其从最终回复中移除（不暴露给用户）。

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

### ✅ 推荐做法

1. **Store 与 Checkpointer 使用同一 PostgreSQL 实例但独立连接池**：共享数据库减少运维成本，独立连接池避免高频 checkpoint 写入影响 Store 操作。
2. **命名空间层级化设计**：`["memories", userId, memoryType]` 而非扁平的 `["user-123-semantic"]`。层级化支持通配符搜索（搜索用户所有类型的记忆）。
3. **Lane Queue 对所有 Thread 感知的操作生效**：不仅是 invoke，HITL resume、thread fork 等操作也应通过 Lane Queue 串行化。
4. **记忆提取使用 XML 标签而非 JSON 包裹**：XML 标签（`<memory_extract>`）比 JSON 包裹更不容易与正常内容混淆，且正则提取更可靠。
5. **技能使用文件系统而非数据库**：Cursor / Claude Code / LangGraph 社区的生产标准是文件系统 SKILL.md，通过三层渐进式加载按需注入，而非向量搜索。

### ⚠️ 踩坑记录

**MessagesValue reducer 导致 SystemMessage 排序错误**：

`loadMemoriesNode` 通过返回 `{ messages: [SystemMessage, ...nonSystemMessages] }` 注入系统提示词。但 `MessagesValue` reducer 的工作方式是**追加新消息、原地替换已有消息**——新的 `SystemMessage` 被追加到已有 `HumanMessage` 之后，导致发送给 LLM 的顺序为 `[Human, System]`。

多数 LLM API 要求 `system` 消息在最前面，否则可能忽略系统指令。实测 SiliconFlow/MiniMax 在此顺序下 `promptTokens` 异常低，记忆提取指令完全失效。

**解决方案**：`callModelNode` 在调用 `model.invoke()` 前显式重排消息：

```typescript
const systemMessages = state.messages.filter(m => m.type === 'system');
const nonSystemMessages = state.messages.filter(m => m.type !== 'system');
const orderedMessages = [...systemMessages, ...nonSystemMessages];
const response = await model.invoke(orderedMessages);
```

此模式适用于所有在节点中动态注入 `SystemMessage` 的场景。

### ❌ 避免做法

1. **不要在 State 中存放记忆**：State 是 Thread-scoped 的，每个线程都会复制一份。记忆应存放在 Store 中。
2. **不要跳过 Lane Queue 直接 invoke**：并发 checkpoint 写入冲突可能导致对话状态丢失，且难以复现和调试。
3. **不要将 InMemoryStore 用于生产环境**：进程重启后所有记忆丢失。InMemoryStore 仅用于开发和测试。
4. **不要在记忆中存储敏感信息**：Store 中的数据可能被语义搜索命中并注入到系统提示词。密码、Token 等敏感信息绝不应存入记忆。
5. **不要过度依赖记忆提取的准确性**：LLM 提取的记忆可能不完整或有误。关键信息应通过显式 API 存储，而非依赖自动提取。
6. **不要假设 MessagesValue 保留消息顺序**：在节点中动态注入 `SystemMessage` 后，调用模型前需显式重排，确保 system 消息在最前面。

## 5. 行动导向 (Action Guide)

### Step 1: 环境配置

**这一步在干什么**：配置 Store 相关的环境变量，控制是否启用 PostgresStore 和记忆 TTL。

```bash
# .env 文件（env.ai 映射文件）添加以下配置：

# --- AI 长期记忆 Store ---
# AI_STORE_ENABLED=true                       # 是否启用 PostgresStore（false 退化为 InMemoryStore）
# AI_STORE_MEMORY_TTL=0                       # 记忆 TTL（秒），0 = 永不过期
# AI_STORE_DEFAULT_SEARCH_LIMIT=5             # 记忆语义搜索默认返回条数

# --- AI 技能文件系统 ---
# AI_SKILLS_DIR=                              # 技能目录路径（默认 src/ai/skills）
```

### Step 2: MemoryStoreService — Store 生命周期管理

**这一步在干什么**：创建与 `CheckpointService` 对称的 Store 管理服务，负责 `PostgresStore` 的初始化、向量搜索配置和连接池释放。

核心文件：`src/ai/agents/memory-store/memory-store.service.ts`

```typescript
import { PostgresStore } from '@langchain/langgraph-checkpoint-postgres/store';
import { InMemoryStore, type BaseStore } from '@langchain/langgraph';

@Injectable()
export class MemoryStoreService implements OnModuleInit, OnModuleDestroy {
  private store: BaseStore;
  private postgresStore: PostgresStore | null = null;

  async onModuleInit(): Promise<void> {
    // 生产模式：PostgresStore + Embedding 向量搜索
    this.postgresStore = PostgresStore.fromConnString(connString, {
      index: {
        dims: 1024,                    // 向量维度（与 Embedding 模型一致）
        embed: embeddings,             // EmbeddingsFactory 创建的实例
        fields: ['content'],            // 参与向量化的字段（仅记忆内容）
      },
      ttl: { defaultTtl: 0 },         // 0 = 永不过期
    });
    await this.postgresStore.setup();  // 幂等建表
    this.store = this.postgresStore;
  }

  // 提供给 Graph 编译时注入
  getStore(): BaseStore { return this.store; }

  // 高层记忆 CRUD（技能已迁移到 SkillLoaderService 文件系统方案）
  async putMemory(userId, type, key, value) { ... }
  async searchMemories(userId, query, options) { ... }
  async deleteMemory(userId, type, key) { ... }
}
```

### Step 3: LaneQueueService — Per-thread 串行队列

**这一步在干什么**：实现按 threadId 维度的请求串行化，防止并发 checkpoint 写入冲突。

核心文件：`src/ai/agents/memory-store/lane-queue.service.ts`

```typescript
@Injectable()
export class LaneQueueService {
  private readonly lanes = new Map<string, Promise<unknown>>();

  async enqueue<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const currentLane = this.lanes.get(threadId) ?? Promise.resolve();

    const newLane = currentLane
      .catch(() => {})  // 前序失败不阻塞后续
      .then(() => fn());

    this.lanes.set(threadId, newLane);

    try {
      return await newLane;
    } finally {
      if (this.lanes.get(threadId) === newLane) {
        this.lanes.delete(threadId);
      }
    }
  }
}
```

### Step 4: Memory Graph — 记忆感知的状态图

**这一步在干什么**：构建 `loadMemories → callModel → extractMemories` 图，实现对话前加载记忆、对话后提取记忆的完整流程。

核心文件：`src/ai/agents/single/memory-graph/memory-graph.builder.ts`

```typescript
export function buildMemoryGraph(options: {
  checkpointer?: BaseCheckpointSaver;
  store: BaseStore;  // 必须注入 Store
}) {
  const graph = new StateGraph(MemoryAgentState)
    .addNode('loadMemories', loadMemoriesNode)
    .addNode('callModel', callModelNode)
    .addNode('executeTools', executeToolsNode)
    .addNode('extractMemories', extractMemoriesNode)
    .addEdge(START, 'loadMemories')
    .addEdge('loadMemories', 'callModel')
    .addConditionalEdges('callModel', shouldContinueOrExtract, {
      executeTools: 'executeTools',
      extractMemories: 'extractMemories',
    })
    .addEdge('executeTools', 'callModel')
    .addEdge('extractMemories', END);

  return graph.compile({
    checkpointer: options.checkpointer,
    store: options.store,  // 节点通过 config.store 访问
  });
}
```

### Step 5: API 端点测试

**这一步在干什么**：通过 HTTP 端点验证完整的记忆体系功能。

```bash
# 1. 创建一条手动记忆
curl -X POST http://localhost:3000/ai/agent/store/memories/user-123 \
  -H "Content-Type: application/json" \
  -d '{
    "type": "semantic",
    "content": "用户偏好暗色主题，使用 TypeScript + NestJS"
  }'

# 2. 查看已注册的技能（文件系统，调试用）
curl http://localhost:3000/ai/agent/skills

# 3. Memory-aware Agent 对话（自动加载记忆 + 提取新记忆）
curl -X POST http://localhost:3000/ai/agent/memory-agent/chat \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "siliconflow",
    "model": "Pro/MiniMaxAI/MiniMax-M2.5",
    "userId": "user-123",
    "messages": [{ "role": "user", "content": "你好，记住我的名字叫张三" }],
    "enableMemoryExtraction": true,
    "enableSkillLoading": false
  }'
# 响应中 memoriesLoaded > 0 表示加载了之前存储的记忆
# 响应中 memoriesStored > 0 表示从回复中提取了新记忆

# 5. 搜索记忆（验证记忆已持久化）
curl "http://localhost:3000/ai/agent/store/memories/user-123/search?query=用户叫什么名字"

# 6. 启用技能加载的对话（Agent 通过 tool call 按需加载技能）
curl -X POST http://localhost:3000/ai/agent/memory-agent/chat \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "siliconflow",
    "model": "Pro/MiniMaxAI/MiniMax-M2.5",
    "userId": "user-123",
    "messages": [{ "role": "user", "content": "帮我审查一下这段代码的安全性" }],
    "enableSkillLoading": true
  }'
# Agent 会自动调用 load_skill("code-review") 加载审查技能

# 7. 新线程中对话（验证跨线程记忆共享）
curl -X POST http://localhost:3000/ai/agent/memory-agent/chat \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "siliconflow",
    "model": "Pro/MiniMaxAI/MiniMax-M2.5",
    "userId": "user-123",
    "messages": [{ "role": "user", "content": "你知道我叫什么名字吗？" }],
    "threadId": "new-thread-id"
  }'
# Agent 应能回忆起用户名字（来自 Store，而非 Thread 内的消息历史）
```

### 文件组织结构

```
src/ai/
├── agents/
│   ├── memory-store/
│   │   ├── index.ts                       # Barrel 导出
│   │   ├── memory-store.types.ts          # 记忆类型定义（MemoryType, MemoryValue）
│   │   ├── memory-store.service.ts        # PostgresStore 生命周期管理（仅记忆）
│   │   ├── memory-agent.service.ts        # Memory-aware Agent 编排
│   │   ├── lane-queue.service.ts          # Per-thread 串行执行队列
│   │   ├── skill-loader.types.ts          # 技能类型定义（SkillMetadata, ParsedSkill）
│   │   └── skill-loader.service.ts        # 文件系统技能加载器
│   └── single/
│       └── memory-graph/
│           ├── index.ts                   # Barrel 导出
│           ├── memory-graph.builder.ts    # Memory Graph 构建器
│           └── memory-graph.prompts.ts    # 记忆 + 技能系统提示词模板
├── skills/                                # 技能文件目录（Agent Skills 标准）
│   └── code-review/
│       ├── SKILL.md                       # YAML frontmatter + Markdown 指令
│       └── references/
│           └── checklist.md               # 辅助资源文件
```

