# 049. 持久化执行与线程管理 (Durable Execution & Thread Lifecycle)

## 1. 核心问题与概念 (The "Why")

### 解决什么问题

048 的 ReAct Agent 是**无状态**的——每次 HTTP 请求启动全新的执行，执行完毕状态即丢弃。这带来三个生产级痛点：

1. **无法断点续传**：Agent 执行到一半遭遇 LLM 超时或网络故障，所有已完成的工具调用结果丢失，只能从头重来。
2. **无法跨请求保持执行上下文**：用户在第一轮对话中让 Agent 查了天气，第二轮想追问"刚才查的那个城市温度是多少"，但上一轮的图执行状态已消失。
3. **无法事后审查和调试**：出了问题只能看日志，无法回溯到具体的中间状态来分析 Agent 的决策路径。

### 核心概念与依赖

| 概念                                 | 定义                                                                   | 与项目已有能力的关系                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Durable Execution 持久执行** | 进程在关键点保存执行进度，允许暂停/恢复/故障恢复                       | 044 的 `RedisChatHistory` 存的是聊天消息，Durable Execution 存的是**图的完整执行状态**                                               |
| **Checkpoint 检查点**          | 一个 super-step 边界的状态快照（State 值 + 待执行节点 + 元数据）       | 每个 checkpoint 是一个可恢复的"存档点"                                                                                                       |
| **Super-step**                 | 图的一次"tick"，所有当前调度的节点在同一 super-step 并行执行           | 在当前 ReAct 图里，通常是 `输入`、`callModel`、`executeTools` 这样的单步边界；如果图有并行分支，一个 super-step 也可能同时包含多个节点 |
| **Thread**                     | 一个独立的 Agent 执行上下文，由 `thread_id` 标识                     | 类似 044 的 `sessionId`，但 thread 存的是图执行状态而非仅消息历史                                                                          |
| **Time-travel**                | 回溯到任意历史 checkpoint，支持 replay（重放）和 fork（分叉）          | 相当于代码调试中的"断点回退"，但作用于 Agent 执行状态                                                                                        |
| **PostgresSaver**              | `@langchain/langgraph-checkpoint-postgres` 提供的生产级 Checkpointer | 复用项目已有的 PostgreSQL，零额外基础设施                                                                                                    |

### Checkpoint 相关术语辨析

LangGraph 官方围绕 "checkpoint" 有三个层次的命名，初看容易混淆：

```text
┌─────────────────────────────────────────────────────────────────────────┐
│  checkpoint          → 数据本身：一个 super-step 边界上的状态快照  
│  checkpointer        → 角色/职责：负责保存和读取 checkpoint 的组件   
│  BaseCheckpointSaver → 类型抽象：checkpointer 角色的实现基类      
│    ├─ MemorySaver    → 内存实现（开发/测试用，进程重启即丢失）       
│    └─ PostgresSaver  → 生产实现（持久化到 PostgreSQL）                
└─────────────────────────────────────────────────────────────────────────┘
```

对应到代码中：

```typescript
// checkpoint.service.ts

// 变量名用 checkpointSaver（或 checkpointer），强调"它是保存快照的组件"
// 类型用 BaseCheckpointSaver，强调"它是存储引擎的抽象基类"
private checkpointSaver: BaseCheckpointSaver;

// 它实际做的事情：
await checkpointSaver.put(config, checkpoint);  // 保存一个 checkpoint（快照数据）
await checkpointSaver.getTuple(config);          // 读取一个 checkpoint

// 图编译时传入的参数名叫 checkpointer：
graph.compile({ checkpointer: checkpointSaver });
```

一句话总结：`checkpoint` 是"被保存的东西"，`checkpointer` / `BaseCheckpointSaver` 是"负责保存它的组件"。类似于 `log` 是日志记录，`logger` 是记录日志的组件。

### `Super-step` 到底是什么

`Super-step` 既不是"整张图完整跑完一次"，也不一定等于"单个节点执行完"。它更准确的含义是：**调度器的一轮执行批次**。这一轮里，所有被安排在当前 step 的节点会一起执行；这一轮全部完成后，LangGraph 才会在边界上写入一个 checkpoint。

可以这样理解：

- **不是整张图**：一次完整图执行通常会经历多个 super-step。
- **不总是单个节点**：如果图里存在并行分支，同一 super-step 里可以有多个节点同时跑。
- **在串行图里看起来像单节点**：如果图是 `START -> A -> B -> END` 这种顺序结构，那么输入、`A`、`B` 会分别形成不同的 super-step，所以它在视觉上很像"一个节点一个 step"。

对当前项目的 ReAct 图来说：

```text
START -> callModel -(conditional)-> executeTools -> callModel -> ...
```

这里 `callModel` 和 `executeTools` 是真正的图节点；`shouldContinue` 只是 `callModel` 执行结束后的**路由判断函数**，不是一个独立的持久化节点。因此当前实现里通常可以这样看：

- `Super-step 0`：输入进入图，产出第一个 checkpoint，`next = ["callModel"]`
- `Super-step 1`：执行 `callModel`，产出 checkpoint，`next` 可能是 `["executeTools"]` 或 `[]`
- `Super-step 2`：如果需要工具调用，执行 `executeTools`，再产出 checkpoint，`next = ["callModel"]`

所以你问的三个选项里，最接近正确答案的是：**它表示图在某一轮调度完成后的边界状态**。checkpoint 保存的就是这个边界上的状态快照，而不是某个节点内部执行到一半的现场。

### Session vs Thread 对比

```
044 Session（RedisChatHistory）          049 Thread（Checkpoint）
─────────────────────────────────────  ─────────────────────────────────────
存储内容: 聊天消息列表                    存储内容: 图的完整执行状态（State 快照）
存储位置: Redis                          存储位置: PostgreSQL
粒度: 一轮对话                           粒度: 每个 super-step 边界
用途: 会话记忆（多轮对话上下文）          用途: 断点续传 + 错误恢复 + Time-travel
生命周期: TTL 过期自动删除               生命周期: 持久存储，支持历史回溯
```

### 传入 `threadId` 时到底发生什么

049 端点与 048 的核心差异，不只是"编译图时多传了一个 `checkpointer`"，还包括：**每次执行都显式把 `thread_id` 传给 LangGraph 运行时**。这意味着图不再是一次性无状态执行，而是会先尝试从持久化层加载该线程已有的 checkpoint。

对 `POST /ai/agent/thread/chat` / `thread/chat/stream` 来说：

- **首次使用某个 `threadId`**：持久化层中还没有该线程历史，图从空状态启动，本次 `messages` 成为起始输入
- **复用已有 `threadId` 且传入新 `messages`**：LangGraph 先加载该线程最新 checkpoint 中的完整 State（尤其是 `messages`、`toolCallCount`、`iterationCount`），再把本次输入消息合并进去，然后从当前图入口继续执行
- **复用已有 `threadId` 且不传 `messages`**：输入为 `null`，表示不追加新消息，而是从最后一个成功 checkpoint 恢复执行

因此，`threadId` 的本质不是普通会话标识，而是：**一条可被持久化、恢复、回溯的图执行链路主键**。

### 与 044 消息持久化是什么关系

`Checkpoint` 和 044 的 `RedisChatHistory` 不是同一个层面的能力：

- **044 消息持久化**：只解决"让模型记住聊过什么"，存的是消息列表
- **049 checkpoint 持久化**：解决"让图引擎记住执行到哪一步"，存的是完整 State 快照

在当前 ReAct Agent 的 049 实现里，checkpoint 的 `values.messages` 已经包含完整消息历史，所以它天然具备"多轮记忆"能力。也就是说：

- **对 049 这条 Agent 端点链路**：通常不需要再额外挂 `RedisChatHistory`
- **对不走 LangGraph Durable Execution 的普通聊天链路**：仍然可以继续用 044 的 Redis 消息持久化

### 生产实践建议

- **纯聊天 / 无工具调用 / 无断点续传需求**：优先用消息历史持久化（如 Redis），实现简单、成本低
- **Agent 工具调用 / 需要错误恢复 / 需要 time-travel**：优先用 checkpoint 持久化，因为仅存消息不足以恢复图执行状态
- **同一系统既有普通对话也有 Agent 编排**：两者并存，按链路选用；普通对话走消息历史，Agent 走 checkpoint

## 2. 核心用法 / 方案设计 (Usage / Design)

### 场景 A: 首次对话 — 创建线程并持久化执行

客户端生成 UUID 作为 `threadId`，首次对话时传入消息列表。每个 super-step 边界自动保存 checkpoint。

```typescript
// POST /ai/agent/thread/chat
{
  "provider": "siliconflow",
  "model": "Pro/MiniMaxAI/MiniMax-M2.5",
  "threadId": "550e8400-e29b-41d4-a716-446655440000",
  "messages": [
    { "role": "user", "content": "帮我查一下北京现在的天气" }
  ],
  "durability": "sync"   // 同步写入 checkpoint，最高可靠性
}

// 响应
{
  "content": "北京现在天气晴朗，温度25°C。",
  "threadId": "550e8400-e29b-41d4-a716-446655440000",
  "iterationCount": 2,
  "toolCallCount": 1
}
```

### 场景 B: 后续对话 — 在现有线程上继续执行

使用同一 `threadId` 发送新消息，图从上次执行结束的状态继续。

```typescript
// POST /ai/agent/thread/chat
{
  "provider": "siliconflow",
  "model": "Pro/MiniMaxAI/MiniMax-M2.5",
  "threadId": "550e8400-e29b-41d4-a716-446655440000",  // 复用同一线程
  "messages": [
    { "role": "user", "content": "那上海呢？" }
  ]
}

// Agent 能"记住"之前查了北京天气，理解"那上海呢"指的是上海的天气
```

### 场景 C: 错误恢复 — 从最后成功的 checkpoint 恢复

当执行中途因 LLM 超时或网络故障中断时，发送空 messages 触发恢复。

```typescript
// POST /ai/agent/thread/chat
{
  "provider": "siliconflow",
  "model": "Pro/MiniMaxAI/MiniMax-M2.5",
  "threadId": "550e8400-e29b-41d4-a716-446655440000"
  // messages 不传或为空数组 → 触发恢复执行
}
```

### 场景 D: Time-travel — 查看历史并分叉

```typescript
// 1. 查看线程历史
// GET /ai/agent/thread/550e8400.../history

// 2. 找到某个工具调用前的 checkpoint
// 3. 从该 checkpoint 分叉
// POST /ai/agent/thread/550e8400.../fork
{
  "checkpointId": "1ef663ba-28f9-6ec4-8001-31981c2c39f8",
  "asNode": "callModel"   // 分叉后从 shouldContinue 继续执行
}

// 4. 使用 thread/chat 端点从分叉点继续
```

## 3. 深度原理与机制 (Under the Hood)

### Durable Execution 三种持久化模式

```
性能 ◄──────────────────────────────────────────────────────► 可靠性

 exit                    async                    sync
  │                        │                        │
  ▼                        ▼                        ▼
仅退出时写入            异步写入                  同步写入
最佳性能                高性能+良好可靠性          最高可靠性
中间状态不保存          进程崩溃可能丢最后一步     每步都安全持久化
```

**选型建议**：

| 场景           | 推荐模式  | 原因                           |
| -------------- | --------- | ------------------------------ |
| 开发调试       | `sync`  | 能完整审查每一步状态           |
| 生产核心流程   | `sync`  | 不可丢失任何执行进度           |
| 高吞吐辅助任务 | `async` | 性能优先，可接受极小丢失概率   |
| 批量处理       | `exit`  | 只关心最终结果，不需要中间状态 |

### Super-step 与 Checkpoint 时序

以 ReAct Agent 执行 "查北京天气" 为例：

```
Super-step 0: __start__ 节点处理输入
  └─ Checkpoint #0: { messages: [HumanMessage("查北京天气")], next: ["callModel"] }

Super-step 1: callModel 节点调用 LLM
  └─ Checkpoint #1: { messages: [..., AIMessage(tool_calls: [getWeather])], next: ["executeTools"] }

Super-step 2: executeTools 节点执行工具
  └─ Checkpoint #2: { messages: [..., ToolMessage("晴，25°C")], next: ["callModel"] }

Super-step 3: callModel 节点生成最终回答
  └─ Checkpoint #3: { messages: [..., AIMessage("北京天气晴朗...")], next: [] }
                                                                          ▲
                                                                     图执行完成
```

每个 checkpoint 包含：

- **values**: 完整的 State 快照（messages、toolCallCount、iterationCount）
- **next**: 待执行的下一个节点列表（空数组 = 图已完成）
- **metadata**: 来源（input/loop/update）、step 编号、节点写入记录
- **config**: thread_id + checkpoint_id（用于精确定位）

### getState 与 getStateHistory 的区别

容易混淆的点：`getState` 返回的 `values.messages` 已经包含从头到尾的所有消息，看起来"什么都有了"。但它只是**最新一个** checkpoint，而不是执行过程。

用上面 "查北京天气" 的例子对比：

```
getState 返回的是 Checkpoint #3（最新快照，1 个对象）：
  messages: [Human("查天气"), AI(tool_calls), Tool("晴25°C"), AI("天气晴朗...")]
  next: []
  step: 3

getStateHistory 返回的是所有 checkpoint（数组，按时间倒序）：
  [0] Checkpoint #3  →  messages 有 4 条，next: []         ← 和 getState 一样
  [1] Checkpoint #2  →  messages 有 3 条，next: [callModel]
  [2] Checkpoint #1  →  messages 有 2 条，next: [executeTools]
  [3] Checkpoint #0  →  messages 有 1 条，next: [callModel]
```

关键区别：

| 维度 | `getState` | `getStateHistory` |
|------|-----------|-------------------|
| 返回 | 1 个快照（最新） | N 个快照（全部历史） |
| messages 长度 | 累积到当前的完整列表 | 每个快照的长度不同，越早越短 |
| 用途 | 恢复界面聊天记录、继续对话 | Time-travel：找到某一步的 checkpointId，用 fork 回到那一刻 |

`messages` 越来越长是因为 State 里 `messages` 字段的 Reducer 是**追加（Append）**模式——每个 super-step 产出的新消息会合并到已有列表末尾。所以最新 checkpoint 的 `messages` 天然包含了所有历史消息，但你**无法从中区分"哪条消息是在哪个 super-step 产生的"**。`getStateHistory` 能做到这一点，因为每个 checkpoint 记录的就是那个时刻的状态切面。
- **parentConfig**: 父 checkpoint 的 ID（形成链式历史）

### task() 持久化语义

`task()` 是 LangGraph 的副作用封装器。当图从 checkpoint 恢复执行时：

1. 图从节点起点重新执行（不是从代码中断行恢复）
2. 已完成的 `task()` **不重新执行**，直接从持久化层读取缓存结果
3. 未完成的 `task()` 正常执行

```typescript
import { task } from '@langchain/langgraph';

// ✅ 正确：API 调用包在 task() 中，恢复时不重复调用
const fetchWeather = task("fetchWeather", async (city: string) => {
  const response = await fetch(`https://api.weather.com/${city}`);
  return response.json();
});

// ❌ 错误：裸调用，恢复时会重复执行
const callModel = async (state) => {
  const weather = await fetch(`https://api.weather.com/beijing`); // 恢复时重复调用！
  return { messages: [new AIMessage(weather)] };
};
```

**幂等性要求**：即使 task 因部分完成后重试，也不会产生副作用（如重复创建订单）。使用幂等键或先检查结果是否已存在。

### PostgresSaver 内部表结构

`PostgresSaver.setup()` 创建的核心表（简化）：

```sql
-- checkpoint 主表
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id    TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type         TEXT,
  checkpoint   JSONB,        -- 序列化的 State 快照
  metadata     JSONB,        -- source, step, writes 等元数据
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
);

-- checkpoint 写入记录（用于 pending writes 和恢复）
CREATE TABLE IF NOT EXISTS checkpoint_writes (
  thread_id    TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL,
  checkpoint_id TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  idx          INTEGER NOT NULL,
  channel      TEXT NOT NULL,
  type         TEXT,
  blob         BYTEA
);
```

### NestJS 集成架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                          AgentController                            │
│  POST /thread/chat    GET /thread/:id/state    POST /thread/:id/fork│
└──────────┬──────────────────┬────────────────────────┬──────────────┘
           │                  │                        │
           ▼                  ▼                        ▼
┌──────────────────┐  ┌───────────────┐  ┌──────────────────────────┐
│   ReactService   │  │ ThreadService │  │   CheckpointService      │
│                  │  │               │  │                          │
│ getDurableGraph()│  │ getState()    │  │ PostgresSaver lifecycle  │
│ invokeWithThread │  │ getHistory()  │  │ getCheckpointer()        │
│ streamWithThread │  │ fork()        │  │ buildConnectionString()  │
└────────┬─────────┘  └───────┬───────┘  └────────────┬─────────────┘
         │                    │                        │
         └────────────────────┼────────────────────────┘
                              │
                              ▼
                ┌──────────────────────────┐
                │   buildToolGraph({       │
                │     checkpointer         │
                │   })                     │
                │                          │
                │   compile() 时注入       │
                │   BaseCheckpointSaver    │
                └──────────────────────────┘
```

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

### ✅ 推荐做法

- **所有非确定性操作包在 `task()` 中**：API 调用、文件读写、随机数生成、获取当前时间
- **保持 task 内操作幂等**：使用幂等键或先查后写策略
- **生产环境使用 `sync` 模式**：除非有明确的性能瓶颈才降级
- **客户端生成 threadId**：使用 UUID v4，由客户端负责线程的关联和复用
- **checkpoint 表加索引**：对 `thread_id` + `checkpoint_ns` 组合索引，加速高频查询
- **定期清理过期线程**：设计 TTL 策略或定时任务清理不再使用的 checkpoint 数据

### ❌ 避免做法

- **避免在 State 中存放不可序列化对象**：函数、类实例、数据库连接等（通过 contextSchema 注入）
- **避免在恢复路径上依赖非持久化的瞬态状态**：UntrackedValue 不写入 checkpoint
- **避免将 `task()` 包在 try-catch 中**：task 的重试机制会被 catch 干扰
- **避免条件性跳过 task**：恢复时 task 索引必须与原始执行一致

### Checkpoint 表与 TypeORM Migration 的关系

项目在 033 章建立了严格的数据库迁移规范：业务表结构变更必须走 TypeORM Migration，禁止依赖 `synchronize: true`。Checkpoint 表**不走这条路**，原因如下：

**Checkpoint 表属于基础设施表，由第三方库自行管理生命周期。**

`PostgresSaver.setup()` 内部维护了一张 `checkpoint_migrations` 表来追踪自己的 schema 版本，每次调用时只执行未跑过的变更（幂等）。这和 TypeORM 自身自动创建 `migrations` 追踪表是同一个设计模式——库管自己的表，业务管业务的表。

如果用 TypeORM migration 手动建 checkpoint 表，会制造**版本耦合风险**：`@langchain/langgraph-checkpoint-postgres` 升级改了内部 schema 时，手写的 migration 文件会过期或不兼容，而 `setup()` 始终和库版本保持一致。

| 表分类     | 管理方式                                   | 示例                                                                   |
| ---------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| 业务表     | TypeORM Migration，手动审查执行            | `users`、`roles`                                                   |
| 基础设施表 | 对应库自行 `setup()`，应用启动时自动就绪 | `checkpoints`、`checkpoint_writes`、`migrations`（TypeORM 自建） |

### 性能影响

| 模式      | 额外延迟（per super-step） | 适用场景     |
| --------- | -------------------------- | ------------ |
| `sync`  | ~5-20ms（PG 写入）         | 核心业务流程 |
| `async` | ~0-2ms（异步发送）         | 高吞吐场景   |
| `exit`  | 0ms（执行期间无额外开销）  | 批量处理     |

### PostgresSaver vs MemorySaver 对比

| 维度     | PostgresSaver           | MemorySaver        |
| -------- | ----------------------- | ------------------ |
| 持久性   | 进程重启后数据保留      | 进程重启后数据丢失 |
| 跨实例   | 多实例共享（分布式）    | 单进程内有效       |
| 适用环境 | 生产                    | 开发/测试          |
| 初始化   | 需要 `setup()` 创建表 | 零配置             |
| 依赖     | PostgreSQL              | 无                 |

## 5. 行动导向 (Action Guide)

### Step 1: 安装依赖

**这一步在干什么**: 安装 LangGraph 官方的 PostgreSQL Checkpointer 包。它实现了 `BaseCheckpointSaver` 接口，将 checkpoint 序列化为 JSONB 存入 PostgreSQL。

```bash
npm install @langchain/langgraph-checkpoint-postgres
```

### Step 2: 配置 Checkpoint 参数

**这一步在干什么**: 在 AI 配置中添加 checkpoint 相关参数。复用已有的数据库连接配置，不引入额外的连接字符串。

```typescript
// src/common/configs/config/ai.config.ts — 新增 checkpoint 段
checkpoint: {
  enabled: process.env.AI_CHECKPOINT_ENABLED !== 'false',
  durabilityMode: (process.env.AI_CHECKPOINT_DURABILITY_MODE as 'sync' | 'async' | 'exit') || 'sync',
},
```

```bash
# .env — 可选覆盖项
# AI_CHECKPOINT_ENABLED=true
# AI_CHECKPOINT_DURABILITY_MODE=sync
```

### Step 3: 实现 CheckpointService

**这一步在干什么**: 创建 NestJS 服务管理 PostgresSaver 的完整生命周期——初始化（创建表）、提供实例、销毁（释放连接池）。支持配置降级为 MemorySaver。

```typescript
// src/ai/agents/persistence/checkpoint.service.ts
@Injectable()
export class CheckpointService implements OnModuleInit, OnModuleDestroy {
  private checkpointer: BaseCheckpointSaver;
  private postgresSaver: PostgresSaver | null = null;

  async onModuleInit(): Promise<void> {
    if (!enabled) {
      this.checkpointer = new MemorySaver();
      return;
    }
    const connString = this.buildConnectionString();
    this.postgresSaver = PostgresSaver.fromConnString(connString);
    await this.postgresSaver.setup(); // 幂等：已存在的表不会重复创建
    this.checkpointer = this.postgresSaver;
  }

  async onModuleDestroy(): Promise<void> {
    await this.postgresSaver?.end(); // 释放连接池
  }

  getCheckpointer(): BaseCheckpointSaver {
    return this.checkpointer;
  }

  // 从已有的 database.config 构建连接字符串
  private buildConnectionString(): string {
    const host = this.configService.get('database.host');
    const port = this.configService.get('database.port');
    const user = this.configService.get('database.user');
    const pass = this.configService.get('database.pass');
    const name = this.configService.get('database.name');
    return `postgresql://${user}:${encodeURIComponent(pass)}@${host}:${port}/${name}`;
  }
}
```

### Step 4: 升级 buildToolGraph 支持 Checkpointer

**这一步在干什么**: 让图构建器接受可选的 `checkpointer` 参数。传入时，图在每个 super-step 边界自动保存 checkpoint。不传时行为与 047/048 完全一致。

```typescript
// src/ai/agents/single/tool-graph/tool-graph.builder.ts
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

export function buildToolGraph(options?: {
  checkpointer?: BaseCheckpointSaver;
}) {
  const graph = new StateGraph(AgentState, ContextSchema)
    .addNode('callModel', callModelNode)
    .addNode('executeTools', executeToolsNode)
    .addEdge(START, 'callModel')
    .addConditionalEdges('callModel', shouldContinue, {
      [ROUTE.TOOLS]: 'executeTools',
      [ROUTE.END]: END,
    })
    .addEdge('executeTools', 'callModel');

  return graph.compile({
    checkpointer: options?.checkpointer,
  });
}
```

### Step 5: 实现 ThreadService

**这一步在干什么**: 创建线程生命周期管理服务，封装 `graph.getState()` / `graph.getStateHistory()` / `graph.updateState()` 操作，并将 LangGraph 的 StateSnapshot 序列化为 HTTP 可传输格式。

序列化消息用 `msg.type`（见 **EXP-005**，`.cursor/experience/modules/ai.md`）。

```typescript
// src/ai/agents/persistence/thread.service.ts
@Injectable()
export class ThreadService {
  async getState(threadId: string, graph: ToolGraphCompiled): Promise<ThreadStateSnapshot> {
    const config = { configurable: { thread_id: threadId } };
    const snapshot = await graph.getState(config);
    return this.serializeSnapshot(threadId, snapshot);
  }

  async getStateHistory(threadId: string, graph: ToolGraphCompiled, limit = 20): Promise<ThreadStateSnapshot[]> {
    const config = { configurable: { thread_id: threadId } };
    const history = [];
    for await (const snapshot of graph.getStateHistory(config)) {
      if (history.length >= limit) break;
      history.push(this.serializeSnapshot(threadId, snapshot));
    }
    return history;
  }

  async fork(threadId: string, checkpointId: string, graph: ToolGraphCompiled, values?: Record<string, unknown>, asNode?: string) {
    const config = { configurable: { thread_id: threadId, checkpoint_id: checkpointId } };
    return graph.updateState(config, values ?? {}, asNode);
  }
}
```

### Step 6: 扩展 ReactService 添加线程感知方法

**这一步在干什么**: 在 ReactService 中添加 `invokeWithThread()` 和 `streamWithThread()` 方法。核心差异：使用带 checkpointer 的持久化图，传入 `thread_id` 和 `durability` 模式。

```typescript
// src/ai/agents/react.service.ts — 关键代码片段
getDurableGraph(): ToolGraphCompiled {
  if (!this.durableGraph) {
    const checkpointer = this.checkpointService.getCheckpointer();
    this.durableGraph = buildToolGraph({ checkpointer });
  }
  return this.durableGraph;
}

async invokeWithThread(params: ReactInvokeParams, threadConfig: ThreadConfig): Promise<ReactInvokeResult> {
  // messages 为空时 input 为 null → 触发错误恢复
  const input = params.messages?.length
    ? { messages: this.buildReactMessages(params.messages, params.systemPrompt) }
    : null;

  const result = await this.getDurableGraph().invoke(input, {
    context,
    configurable: { thread_id: threadConfig.threadId },
    durability: threadConfig.durability ?? 'sync',
  });
}
```

### Step 7: 添加 API 端点

**这一步在干什么**: 在 AgentController 中添加 5 个新端点，覆盖持久化对话、状态查询、历史回溯和 Time-travel 分叉。

```
POST   /ai/agent/thread/chat              线程感知的持久化非流式对话
POST   /ai/agent/thread/chat/stream        线程感知的持久化流式对话
GET    /ai/agent/thread/:threadId/state    获取线程当前状态
GET    /ai/agent/thread/:threadId/history  获取线程 checkpoint 历史
POST   /ai/agent/thread/:threadId/fork    从历史 checkpoint 分叉（Time-travel）
```

#### Apipost 测试参数

为了快速联调，下面给出每个 049 端点可直接粘贴到 Apipost 的最小测试参数。

http://localhost:3000/ai/agent/thread/chat

**1. `POST /ai/agent/thread/chat` — 首次对话 / 后续对话**

```json
{
  "provider": "siliconflow",
  "model": "Pro/MiniMaxAI/MiniMax-M2.5",
  "threadId": "550e8400-e29b-41d4-a716-446655440000",
  "messages": [
    {
      "role": "user",
      "content": "帮我查一下北京现在的天气"
    }
  ],
  "durability": "sync"
}
```

- `threadId`: 必填，UUID v4；首次由客户端生成，后续继续复用
- `messages`: 首次对话或追问时传入消息数组
- `durability`: 可选，`sync | async | exit`，调试阶段建议用 `sync`

**2. `POST /ai/agent/thread/chat` — 错误恢复 / 断点续传**

```json
{
  "provider": "siliconflow",
  "model": "Pro/MiniMaxAI/MiniMax-M2.5",
  "threadId": "550e8400-e29b-41d4-a716-446655440000"
}
```

- 不传 `messages`（或传空数组）表示：从该线程最后一个成功 checkpoint 继续执行

**3. `POST /ai/agent/thread/chat/stream` — 流式持久化对话**

请求体与 `thread/chat` 完全一致，只是响应为 SSE 流。

```json
{
  "provider": "siliconflow",
  "model": "Pro/MiniMaxAI/MiniMax-M2.5",
  "threadId": "550e8400-e29b-41d4-a716-446655440000",
  "messages": [
    {
      "role": "user",
      "content": "那上海呢？"
    }
  ],
  "durability": "sync"
}
```

**4. `GET /ai/agent/thread/:threadId/state` — 当前状态**

```text
/ai/agent/thread/550e8400-e29b-41d4-a716-446655440000/state
```

- 无请求体
- `threadId` 放在路径参数中

**5. `GET /ai/agent/thread/:threadId/history` — checkpoint 历史**

```text
/ai/agent/thread/550e8400-e29b-41d4-a716-446655440000/history?limit=10
```

- 无请求体
- `limit` 可选，默认 `20`

**6. `POST /ai/agent/thread/:threadId/fork` — 从历史 checkpoint 分叉**

```json
{
  "checkpointId": "1ef663ba-28f9-6ec4-8001-31981c2c39f8",
  "asNode": "callModel"
}
```

- `checkpointId`: 必填，从 `history` 接口返回结果中复制
- `asNode`: 可选；当前 ReAct 图里常用 `callModel`，表示这次更新视为 `callModel` 节点写入，后续从路由判断继续执行

**推荐联调顺序**：

1. 先调用 `thread/chat` 创建线程并产出 checkpoint
2. 再调用 `state` / `history` 查看当前状态与历史
3. 从 `history` 中挑一个 `checkpointId` 调用 `fork`
4. 最后再次调用 `thread/chat`，观察是否从分叉点继续执行

### Step 8: 注册服务到 AiModule

**这一步在干什么**: 将 CheckpointService 和 ThreadService 注册到 AiModule 的 providers 和 exports 中。

```typescript
// src/ai/ai.module.ts
providers: [
  // ...existing...
  CheckpointService,
  ThreadService,
],
exports: [
  // ...existing...
  CheckpointService,
  ThreadService,
],
```
