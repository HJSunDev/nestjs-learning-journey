# 044. 生产级多轮会话管理 (Memory & Redis)

## 1. 核心问题与概念 (The "Why")

### 解决什么问题

前面章节（041-043）构建的 LCEL 管道都是**无状态**的：每次请求，客户端必须在 `messages` 数组中传递完整的对话历史。这在生产环境中带来三个问题：

1. **网络开销**：随着对话深入，每次请求携带的消息列表线性增长
2. **状态一致性**：客户端承担了历史管理责任，多端同步困难
3. **上下文溢出**：无法自动控制发送给模型的历史长度，可能超出 context window

本章的目标是将对话历史的管理责任从客户端转移到服务端，构建**有状态会话 API**。

### Redis 在这里的角色：会话热缓存，而非持久存储

**这是最关键的认知**：Redis 在本架构中扮演的是**活跃会话的工作记忆（Working Memory）**，而不是消息的最终持久存储。消息的持久存储应该由数据库（PostgreSQL、MongoDB 等）来承担。

为什么用 Redis 而不是直接读写数据库？因为**多轮对话对延迟极其敏感**：

| 操作场景               | 数据库 (PostgreSQL)      | Redis                    |
| ---------------------- | ------------------------ | ------------------------ |
| 读取 20 条历史消息     | 5-15ms (索引查询 + 网络) | 0.1-0.5ms (内存直读)     |
| 写入 1 条新消息        | 3-10ms (WAL + fsync)     | 0.05-0.2ms (内存写入)    |
| 并发 1000 会话同时读写 | 连接池压力大，需排队     | 单线程事件循环，轻松应对 |

在一次对话请求中，LangChain 的 `RunnableWithMessageHistory` 会依次执行：加载历史 → 拼入提示 → 调用模型 → 写回新消息。这个"加载 + 写回"的 I/O 发生在**每一次请求的关键路径上**，用数据库做这件事的延迟会直接叠加到用户感知的响应时间里。Redis 的亚毫秒级读写让这个开销可以忽略不计。

**那数据库呢？** 在完整的生产架构中，消息应该**异步持久化**到数据库——用于 UI 展示历史、审计合规、数据分析等。Redis 里的数据带 TTL（过期时间），会自动清理；数据库里的数据才是永久记录。本章聚焦于 Redis 层的会话管理，数据库持久化层将在后续章节补充。

用一句话总结 Redis 的定位：**它是 AI 对话链的"短期记忆"——快速、临时、带自动遗忘机制（TTL）**。

### 生产级对话记忆的完整分层架构

一个生产级 AI 对话系统的记忆管理通常包含三个层次：

```
┌─────────────────────────────────────────────────────────────────────┐
│                      模型上下文 (Model Context)                      │
│  最终送入 LLM 的内容 = System Prompt + 用户记忆摘要 + 窗口内历史消息    │
│  ↑ 受 context window 大小限制（如 128K tokens）                       │
│  ↑ 只取最近 N 条（滑动窗口）或经过摘要压缩的历史                        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ 读取（按窗口裁剪）
┌──────────────────────────────▼──────────────────────────────────────┐
│                   Redis 热缓存 (Working Memory)                      │
│  存储活跃会话的完整消息列表（Redis List）                              │
│  • 每次对话读写都走这里（亚毫秒级延迟）                                │
│  • 带 TTL 自动过期（如 1 小时无交互则清除）                            │
│  • 滑动过期：每次写入刷新 TTL，持续对话则不会过期                       │
│  • 角色：服务端的"短期工作记忆"                                       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ 异步持久化（本章未实现，后续扩展）
┌──────────────────────────────▼──────────────────────────────────────┐
│                   数据库持久层 (Long-term Storage)                   │
│  PostgreSQL / MongoDB 存储全量对话记录                                │
│  • 用于 UI 展示完整历史（像微信一样可无限上翻）                         │
│  • 用于审计合规、数据分析、模型微调数据集                               │
│  • 用于用户长期记忆提取（见下文"持久记忆"策略）                         │
│  • 角色：永久归档存储                                                 │
└─────────────────────────────────────────────────────────────────────┘
```

### TTL（自动过期）机制详解

Redis 天然支持 Key 级别的 TTL（Time To Live），这正是它适合做会话热缓存的核心原因之一。本项目的 TTL 策略：

**滑动过期（Sliding Expiration）**：

```
用户发第1条消息 → 创建 Key，设 TTL = 3600s（1小时）
用户发第2条消息 → 写入消息，TTL 重置为 3600s  ← 关键：每次写入都刷新
用户发第3条消息 → 写入消息，TTL 再次重置为 3600s
... 用户离开，不再发消息 ...
3600s 后 → Redis 自动删除该 Key，内存释放
```

**为什么选择滑动过期而非固定过期？**

- 固定过期：创建时设一次 TTL，之后不管用户是否活跃，到时间就删。如果用户正在聊天中会话突然消失，体验灾难。
- 滑动过期：只要用户持续对话，TTL 就不断续期。只有用户真正"离开"（不再发消息）超过设定时间后，才会过期清理。

**代码中的实现**（`RedisChatHistory.refreshTTL()`）：

```typescript
// 每次 addMessage / addMessages 后调用
private async refreshTTL(): Promise<void> {
  if (this.sessionTTL && this.sessionTTL > 0) {
    await this.client.expire(this.sessionKey, this.sessionTTL);
  }
}
```

**Redis 过期的底层机制**：Redis 并不是到时间就立即删除 Key，而是采用**惰性删除 + 定期采样**双机制：

- 惰性删除：访问 Key 时检查是否过期，过期则删除并返回空
- 定期采样：每秒随机抽取一批 Key 检查过期，避免大量 Key 同时过期导致内存峰值

这意味着已过期的 Key 可能短暂存在于内存中（直到被访问或被采样到），但对业务完全透明。

**默认 TTL 值的选择**：项目默认 3600 秒（1 小时），可通过环境变量 `AI_MEMORY_SESSION_TTL` 覆盖。生产环境中应根据业务场景选择：

| 场景                      | 推荐 TTL   | 理由                                   |
| ------------------------- | ---------- | -------------------------------------- |
| 客服对话                  | 15-30 分钟 | 对话通常短平快，结束后很快不再需要     |
| 通用聊天助手              | 1-2 小时   | 用户可能中途离开再回来继续             |
| 深度工作助手（编程/写作） | 4-8 小时   | 用户可能长时间工作中穿插使用           |
| 需要跨天延续的场景        | 24-72 小时 | 配合数据库持久化，Redis 作为缓存加速层 |

### 现代 AI 产品的记忆策略分析

你提到的豆包是一个很好的观察角度。我们来分析主流 AI 产品实际怎么做记忆管理：

#### ChatGPT 的四层记忆架构

OpenAI 在 ChatGPT 中采用了一个明确的分层记忆系统：

1. **会话元数据（Session Metadata）**——临时性。设备类型、时区、屏幕尺寸等环境信息，会话结束即丢弃。
2. **用户持久记忆（User Memory）**——永久性。跨所有对话生效的用户事实，如姓名、职业、偏好、项目信息。通过对话中检测"重要信息"触发存储（用户可确认/拒绝/手动删除）。
3. **近期对话摘要（Recent Conversations）**——半持久性。过往对话的标题和简要摘要，话题匹配时可检索。
4. **当前会话上下文（Current Context Window）**——临时性。当前对话的完整消息，关闭即消失。

其中，**用户持久记忆**是关键创新：它不存储原始对话，而是提取**结构化事实**（"用户是前端工程师"、"偏好 TypeScript"），注入到每次对话的 System Prompt 中。这让用户在新会话中也能感到"AI 记住了我"。

#### 豆包的"无缝单线程"体验

豆包（字节跳动）的移动端刻意隐藏了"切换会话"的概念，用户体验类似微信聊天——连续的消息流，没有"新建对话"按钮。但这并不意味着所有消息都发给了模型。其底层很可能采用：

- **数据库存全量**：所有消息持久化到数据库，UI 上可无限上翻查看历史（和微信一样）
- **窗口化发送**：实际发给模型的只有最近 N 条消息（滑动窗口）
- **持久记忆注入**：从历史对话中提取用户偏好/事实，以 System Prompt 方式注入
- **可能的摘要机制**：超过窗口的旧消息可能被压缩为摘要，拼在窗口前面

用户感知到的是"一个永远记得我的 AI"，实际是"短期窗口 + 长期事实提取"的组合。

#### 核心策略对比

| 策略                   | 原理                             | 优点               | 缺点                   | 适用场景          |
| ---------------------- | -------------------------------- | ------------------ | ---------------------- | ----------------- |
| **滑动窗口**     | 只取最近 N 条消息                | 实现简单，成本可控 | 完全丢失窗口外的上下文 | 短对话、客服场景  |
| **摘要压缩**     | 用 LLM 将旧消息压缩为摘要        | 保留关键语义       | 额外 LLM 调用开销      | 长对话、深度讨论  |
| **混合策略**     | 最近 N 条原文 + 更早的摘要       | 兼顾精度和成本     | 实现复杂度高           | 通用助手          |
| **持久记忆**     | 提取用户事实，跨会话注入         | "AI 记住我"的体验  | 需要事实提取链路       | ChatGPT-like 产品 |
| **锚定迭代摘要** | 不重新生成完整摘要，而是增量追加 | 压缩稳定性最高     | 实现最复杂             | 超长会话、Agent   |

**本章实现的是"滑动窗口"策略**——生产环境中最基础也是最实用的策略。它在 Redis 中写全量（保留完整记录用于审计/回溯），读取时只取最近 N 条发给模型。摘要压缩和持久记忆是进阶策略，可在此基础上叠加。

### 核心概念与依赖

| 概念                           | 角色                                                                              | 所属包                    |
| ------------------------------ | --------------------------------------------------------------------------------- | ------------------------- |
| `BaseChatMessageHistory`     | 对话历史存储的抽象基类，定义 `getMessages()`/`addMessage()`/`clear()` 接口  | `@langchain/core`       |
| `RunnableWithMessageHistory` | LCEL 链的装饰器，在运行时自动加载历史、注入提示模板、持久化新消息                 | `@langchain/core`       |
| `StoredMessage`              | LangChain 消息的序列化格式 `{ type, data }`                                     | `@langchain/core`       |
| `RedisChatHistory`           | **自行实现**的 `BaseListChatMessageHistory`，基于 ioredis 操作 Redis List | 项目内 `src/ai/memory/` |
| `WindowedChatHistory`        | 装饰器模式，对 `getMessages()` 施加滑动窗口裁剪                                 | 项目内 `src/ai/memory/` |

**为什么不用 `@langchain/community` 的 `RedisChatMessageHistory`？**

`@langchain/community` 是一个包含数百个集成的巨型包（浏览器自动化、各类向量数据库等），安装时与项目的 `dotenv@^17` 产生依赖冲突。我们需要的 `RedisChatMessageHistory` 本质仅是 Redis List 的 RPUSH/LRANGE/DEL + 消息序列化，大约 80 行代码。自行实现的优势：

- **零新依赖**：复用已有的 `@langchain/core` + `ioredis`
- **零冲突**：不引入不可控的传递依赖
- **完全可控**：可按需扩展（如滑动过期、批量写入优化）

## 2. 核心用法 / 方案设计 (Usage / Design)

### 场景 A: 有状态对话（无状态 vs 有状态对比）

**无状态方式（041-043 章节）**——客户端维护完整历史：

```typescript
// 客户端每次都要发送完整消息列表
POST /ai/lcel/chat
{
  "messages": [
    { "role": "user", "content": "你好" },
    { "role": "assistant", "content": "你好！有什么可以帮你？" },
    { "role": "user", "content": "介绍一下 NestJS" },
    { "role": "assistant", "content": "NestJS 是..." },
    { "role": "user", "content": "它的 DI 系统怎么工作的？" }   // ← 历史越来越长
  ]
}
```

**有状态方式（本章）**——客户端只发当前消息 + sessionId：

```typescript
// 第一轮
POST /ai/lcel/memory/chat
{ "sessionId": "user-001:general", "input": "你好" }

// 第二轮（服务端自动从 Redis 加载历史）
POST /ai/lcel/memory/chat
{ "sessionId": "user-001:general", "input": "介绍一下 NestJS" }

// 第三轮
POST /ai/lcel/memory/chat
{ "sessionId": "user-001:general", "input": "它的 DI 系统怎么工作的？" }
```

**sessionId 的来源**：当前实现中 sessionId 是客户端传入的必填字段，服务端不负责生成。第一次会话时客户端生成一个新 ID（如 UUID），后续请求携带同一个 ID 即可延续会话。服务端不需要"创建会话"接口——Redis 的 RPUSH 在 Key 不存在时会自动创建空 List 再追加，所以任何从未出现过的 sessionId 都会自动开始一个新会话。

这是当前没有用户系统时的合理做法。生产环境接入用户系统后，sessionId 应由服务端生成并绑定用户 ID（如 `userId:uuid`），同时校验请求中的 sessionId 是否属于当前登录用户，防止越权访问他人的对话历史。

**请求时的数据流**（以第三轮为例）：

```
客户端发送: { sessionId: "user-001:general", input: "DI 系统怎么工作的？" }
           │
           ▼
┌─ RunnableWithMessageHistory ──────────────────────────────────────┐
│  1. 从 configurable.sessionId 提取会话 ID                      
│  2. 调用 ChatHistoryFactory.create(sessionId) 获取历史实例  
│     → RedisChatHistory(windowSize=20) 包装为 WindowedChatHistory   
│  3. 调用 getMessages() 从 Redis 读取历史   
│     → LRANGE chat_history:user-001:general 0 -1   
│     → 反序列化为 [HumanMsg, AIMsg, HumanMsg, AIMsg]  
│     → 滑动窗口裁剪 slice(-20)                   
│  4. 注入到 prompt 模板的 {history} 占位符          
│  5. 当前输入注入到 {input} 占位符                    
│  6. 拼接后发送给模型 → 模型返回响应                     
│  7. 将 HumanMessage(input) + AIMessage(response) 写回 Redis   
│     → RPUSH chat_history:user-001:general [序列化消息]     
│     → EXPIRE chat_history:user-001:general 3600  ← 刷新 TTL   
└───────────────────────────────────────────────────────────────────┘
           │
           ▼
客户端收到: { content: "NestJS 的 DI 系统基于...", sessionId: "user-001:general" }
```

### 场景 B: 会话管理（查询、清除）

```typescript
// 列出所有活跃会话
GET /ai/lcel/memory/sessions
// → { "sessions": [{ "sessionId": "user-001:general", "messageCount": 6, "ttl": 3200 }], "total": 1 }

// 查看某个会话的完整历史
GET /ai/lcel/memory/sessions/user-001:general
// → { "sessionId": "...", "messages": [...], "messageCount": 6, "ttl": 3200 }

// 清除会话
DELETE /ai/lcel/memory/sessions/user-001:general
// → 204 No Content
```

### 场景 C: 窗口裁剪（控制 Token 预算）

```typescript
POST /ai/lcel/memory/chat
{
  "sessionId": "user-001:long-talk",
  "input": "继续聊",
  "maxHistoryLength": 10  // 只取 Redis 中最近 10 条消息发给模型
}
```

Redis 中存储全量历史（用于审计/回溯），但模型只看到最近 N 条。这就是"写全量、读窗口"的设计。

## 3. 深度原理与机制 (Under the Hood)

### RunnableWithMessageHistory 的生命周期

`RunnableWithMessageHistory` 是 `RunnableBinding` 的子类，在 `invoke()` / `stream()` 时自动执行：

1. **_enterHistory**：从 `configurable.sessionId` 提取 sessionId → 调用 `getMessageHistory(sessionId)` 获取存储实例 → 调用 `getMessages()` 加载历史 → 注入到链输入的 `historyMessagesKey` 字段
2. **执行链**：prompt 模板用 `history` 占位符接收历史 + `{input}` 接收当前输入 → pipe 到 model
3. **_exitHistory**：将用户输入（HumanMessage）和模型输出（AIMessage）追加到存储

### BaseListChatMessageHistory 抽象基类

`RedisChatHistory` 继承的 `BaseListChatMessageHistory` 是 LangChain 为**列表式对话历史存储**定义的抽象基类（来自 `@langchain/core/chat_history`）。它的接口定义了"对话历史存储"必须具备的能力：

```typescript
// @langchain/core 中的定义（简化）
abstract class BaseListChatMessageHistory extends Serializable {
  abstract getMessages(): Promise<BaseMessage[]>;     // 读取全部历史消息
  abstract addMessage(message: BaseMessage): Promise<void>;  // 写入一条消息

  // 以下方法已有默认实现，子类可按需覆盖
  addUserMessage(message: string): Promise<void>;     // 便捷方法，内部构造 HumanMessage 后调 addMessage
  addAIMessage(message: string): Promise<void>;       // 便捷方法，内部构造 AIMessage 后调 addMessage
  addMessages(messages: BaseMessage[]): Promise<void>; // 批量添加，默认逐条调 addMessage
  clear(): Promise<void>;                             // 清空历史
}
```

LangChain 自带一个内存实现 `InMemoryChatMessageHistory`（用 JavaScript 数组存储），我们的 `RedisChatHistory` 则用 Redis List 替代了内存数组。

继承它的意义在于与 `RunnableWithMessageHistory` 解耦：`RunnableWithMessageHistory` 在构造时需要一个 `getMessageHistory(sessionId): BaseChatMessageHistory` 工厂函数。每次请求时，它调用工厂获取实例，然后调用实例的 `getMessages()` 加载历史、调用 `addMessage()` 写入新消息。它不关心底层存储是内存、Redis 还是 PostgreSQL——只要实现了这个抽象类的接口就行。这是依赖倒置（DIP）的典型应用。

与 `BaseChatMessageHistory`（另一个基类，所有方法都是 abstract）相比，`BaseListChatMessageHistory` 提供了更多默认实现，继承它时只需实现核心的 `getMessages()` 和 `addMessage()` 就能跑起来。我们的 `RedisChatHistory` 额外覆盖了 `addMessages()` 以使用 Redis Pipeline 优化批量写入。

### ioredis 与 Redis List 命令详解

`RedisChatHistory` 中 `this.client` 的类型是 `Redis`（来自 `ioredis` 库）。ioredis 是 Node.js 中最主流的 Redis 客户端，它的 API 设计原则：**Redis 服务端有什么命令，ioredis 就暴露什么同名方法**。所以 `client.lrange()`、`client.rpush()` 不是 ioredis 自己发明的 API，而是对 Redis 原生命令的一对一映射。

Redis 有多种数据结构（String、List、Hash、Set、Sorted Set 等），本项目用的是 **List（有序列表）**。以下是代码中用到的全部 Redis 命令：

#### RPUSH — 从列表右端追加元素

```typescript
await this.client.rpush(this.sessionKey, JSON.stringify(serialized));
// 等价于 Redis CLI: RPUSH chat_history:session-001 '{"type":"human","data":{...}}'
```

将一个值追加到列表的**右端（尾部）**。如果 Key 不存在，Redis 自动创建一个空列表再追加。返回列表新长度。O(1) 时间复杂度。

```
执行前：  List = ["消息A", "消息B"]
执行：    RPUSH key "消息C"
执行后：  List = ["消息A", "消息B", "消息C"]
                                     ↑ 追加到尾部
```

与之对应的 `LPUSH` 是从左端（头部）插入。对话消息用 `RPUSH` 是因为消息按时间顺序追加到尾部，后续 `LRANGE 0 -1` 读出来天然就是时间正序。

#### LRANGE — 按索引范围读取列表元素

```typescript
const raw = await this.client.lrange(this.sessionKey, 0, -1);
// 等价于 Redis CLI: LRANGE chat_history:session-001 0 -1
```

返回列表中从索引 `start` 到 `stop`（闭区间）的所有元素。索引从 0 开始，负数表示从右端倒数（`-1` = 最后一个元素）。

```
Redis List: ["消息A", "消息B", "消息C", "消息D"]
              ↑ 0       ↑ 1       ↑ 2       ↑ 3（也是 -1）

lrange(key, 0, -1)  → ["消息A", "消息B", "消息C", "消息D"]  // 全部元素
lrange(key, 0, 1)   → ["消息A", "消息B"]                    // 前两个
lrange(key, -2, -1) → ["消息C", "消息D"]                    // 最后两个（可用于服务端侧窗口裁剪）
```

时间复杂度 O(S+N)，S 是 start 偏移量，N 是返回的元素数量。

#### DEL — 删除 Key

```typescript
await this.client.del(this.sessionKey);
// 等价于 Redis CLI: DEL chat_history:session-001
```

删除指定的 Key 及其所有数据（不管是 String、List、Hash 还是其他类型）。返回实际被删除的 Key 数量（0 或 1）。用于清空会话——删除整个 List Key，下次写入时 Redis 自动创建新的空 List。

#### EXPIRE — 设置 Key 的生存时间（TTL）

```typescript
await this.client.expire(this.sessionKey, this.sessionTTL);
// 等价于 Redis CLI: EXPIRE chat_history:session-001 3600
```

给 Key 设一个倒计时（单位：秒），到期后 Redis 自动删除这个 Key。每次调用都会**覆盖**之前的 TTL，这正是"滑动过期"的实现基础——每次写消息后重新设 TTL，倒计时重头开始。

```
EXPIRE key 3600  → 从现在起 3600 秒后自动删除
... 30 分钟后用户又发了一条消息 ...
EXPIRE key 3600  → 倒计时重新从 3600 秒开始（不是累加）
```

返回 1 表示设置成功，0 表示 Key 不存在。

#### LLEN — 获取列表长度

```
Redis CLI: LLEN chat_history:session-001
返回值:    (integer) 6
```

返回指定 List Key 中的**元素数量**。如果 Key 不存在返回 0。O(1) 时间复杂度（Redis 在 List 内部维护了长度计数器，不需要遍历）。

在 `SessionManagerService` 中，用它获取会话的消息条数——不需要读取消息内容本身，只需要知道"有多少条"。

#### TTL — 查询 Key 的剩余生存时间

```
Redis CLI: TTL chat_history:session-001
返回值:    (integer) 3200
```

返回指定 Key 的**剩余生存时间**（单位：秒）。注意两个特殊返回值：

| 返回值 | 含义 |
|---|---|
| 正整数（如 3200） | Key 存在且设了过期时间，还剩 3200 秒过期 |
| -1 | Key 存在但**没有设置过期时间**（永不过期） |
| -2 | Key **不存在**（已过期或从未创建） |

O(1) 时间复杂度。与 `EXPIRE`（设置 TTL）是一对读写关系：`EXPIRE` 负责写入过期时间，`TTL` 负责查询剩余时间。

#### Pipeline — 批量命令管道（ioredis 客户端特性）

`pipeline()` 不是 Redis 服务端命令，是 ioredis 提供的**客户端侧批量优化**。要理解它，先看普通模式的问题：

```
普通模式（逐条发送，3 条命令 = 3 次网络往返）：
  客户端 ──RPUSH──→ Redis ──响应──→ 客户端     ← 等这次响应回来
  客户端 ──RPUSH──→ Redis ──响应──→ 客户端     ← 才发下一条
  客户端 ──RPUSH──→ Redis ──响应──→ 客户端
  总耗时 ≈ 3 × 网络 RTT

Pipeline 模式（打包发送，3 条命令 = 1 次网络往返）：
  客户端 ──[RPUSH, RPUSH, RPUSH]──→ Redis ──[响应, 响应, 响应]──→ 客户端
  总耗时 ≈ 1 × 网络 RTT
```

**关键点：Pipeline 模式下，命令入队时不会立即执行，也没有返回值**。所有命令攒在本地，调用 `exec()` 时一次性发送给 Redis，再一次性收回所有结果。

**`exec()` 的返回值结构：`[error, result][]`**

`exec()` 返回一个二维数组，每个元素是一个 `[error, result]` 元组，**按命令入队顺序排列**：

```typescript
// session-manager.service.ts — 查询会话元信息
const pipeline = this.redis.pipeline();
pipeline.llen(key);     // 入队第 1 条命令（索引 0）
pipeline.ttl(key);      // 入队第 2 条命令（索引 1）
const results = await pipeline.exec();

// results 的实际结构：
// [
//   [null, 6],       ← 索引 0：LLEN 的结果 → error=null, result=6（6 条消息）
//   [null, 3200],    ← 索引 1：TTL 的结果  → error=null, result=3200（剩余 3200 秒）
// ]

// 所以取值方式是：
const messageCount = (results?.[0]?.[1] as number) ?? 0;    // results[0][1] = 6
const ttl = (results?.[1]?.[1] as number) ?? -2;            // results[1][1] = 3200
```

每个元组的两个元素：
- `[0]` — error：如果该命令执行失败则为 Error 对象，成功则为 `null`
- `[1]` — result：该命令的实际返回值（与单独执行该命令时的返回值相同）

**再看一个批量写入的例子**（`RedisChatHistory.addMessages()`）：

```typescript
const pipeline = this.client.pipeline();
for (const msg of serialized) {
  pipeline.rpush(this.sessionKey, JSON.stringify(msg));  // 入队 N 条 RPUSH
}
await pipeline.exec();
// 这里不关心返回值，只是利用 Pipeline 把 N 次网络往返降为 1 次
```

**Pipeline 与事务（`MULTI/EXEC`）的区别**：Pipeline 只是**打包传输**，命令之间不保证原子性（中间可能穿插其他客户端的命令）。如果需要原子性，要用 ioredis 的 `pipeline().multi()` 组合事务。本场景中不需要——消息追加的顺序性由 Redis 单线程执行模型天然保证。

### Redis 存储结构

```
Key:   chat_history:{sessionId}
Type:  List (有序，RPUSH 追加保证时间顺序)
Value: [StoredMessage_JSON_0, StoredMessage_JSON_1, ...]
TTL:   可配置，每次写入后刷新（滑动过期）
```

**为什么用 Redis List 而不是 Hash 或 Sorted Set？**

- List 的 RPUSH 是 O(1) 追加，LRANGE 是 O(S+N) 范围读取，天然适合"按时间顺序追加、按范围读取"的消息场景
- 不需要按 score 排序（消息本身就是时间有序追加的，RPUSH 保证先进先排）
- 不需要字段级更新（对话链路中消息写入后不再修改；变更操作通过 DEL 整个 Key 后从 DB 回填实现）

### 消息序列化：StoredMessage 与转换函数

LangChain 内部使用 `BaseMessage` 的子类（`HumanMessage`、`AIMessage`、`SystemMessage` 等）来表示对话消息。这些是**运行时的富对象**，带有方法、类型信息等。但存储到 Redis 时不能直接存对象实例——需要转成纯 JSON。

LangChain 为此定义了一个中间序列化格式 `StoredMessage`：

```typescript
// @langchain/core 中的类型定义
interface StoredMessageData {
  content: string;
  role: string | undefined;
  name: string | undefined;
  tool_call_id: string | undefined;
  additional_kwargs?: Record<string, any>;
  response_metadata?: Record<string, any>;
  id?: string;
}

interface StoredMessage {
  type: string;    // "human" | "ai" | "system" | "tool" | "function" | "chat"
  data: StoredMessageData;
}
```

存储到 Redis 中的每条消息就是一个 `StoredMessage` 的 JSON 字符串：

```json
{
  "type": "human",
  "data": {
    "content": "你好",
    "role": "human",
    "name": null,
    "tool_call_id": null
  }
}
```

**`mapChatMessagesToStoredMessages()` — 序列化（运行时对象 → 可存储格式）**

```typescript
import { mapChatMessagesToStoredMessages } from '@langchain/core/messages';

// 输入：LangChain 运行时对象
const messages: BaseMessage[] = [new HumanMessage("你好"), new AIMessage("你好！")];

// 输出：纯数据结构，可以 JSON.stringify 后存入 Redis
const stored: StoredMessage[] = mapChatMessagesToStoredMessages(messages);
// → [
//     { type: "human", data: { content: "你好", role: "human", ... } },
//     { type: "ai",    data: { content: "你好！", role: "assistant", ... } }
//   ]
```

内部实现：遍历每个 `BaseMessage`，调用它的 `toDict()` 方法将富对象提取为纯数据结构。

**`mapStoredMessagesToChatMessages()` — 反序列化（存储格式 → 运行时对象）**

```typescript
import { mapStoredMessagesToChatMessages } from '@langchain/core/messages';

// 输入：从 Redis 读出并 JSON.parse 后的纯数据
const stored: StoredMessage[] = [
  { type: "human", data: { content: "你好", role: "human" } },
  { type: "ai",    data: { content: "你好！", role: "assistant" } }
];

// 输出：LangChain 运行时对象实例，可直接注入 Prompt 模板
const messages: BaseMessage[] = mapStoredMessagesToChatMessages(stored);
// → [HumanMessage { content: "你好" }, AIMessage { content: "你好！" }]
```

内部实现：根据 `type` 字段决定实例化哪个子类（`"human"` → `new HumanMessage()`，`"ai"` → `new AIMessage()`，`"system"` → `new SystemMessage()`，以此类推）。

**`RedisChatHistory` 中的完整数据流：**

```
写入路径（addMessage / addMessages）：
  BaseMessage 实例
    → mapChatMessagesToStoredMessages() → StoredMessage 纯数据
    → JSON.stringify()                 → string
    → RPUSH 写入 Redis List

读取路径（getMessages）：
  LRANGE 0 -1 从 Redis List 读取  → string[]
    → JSON.parse()                → StoredMessage[] 纯数据
    → mapStoredMessagesToChatMessages() → BaseMessage[] 运行时实例
```

### 滑动窗口 (WindowedChatHistory) 的装饰器模式

```
                            ┌─────────────────────┐
                            │ WindowedChatHistory │ ← RunnableWithMessageHistory 调用
                            │   windowSize = 20   │
                            └──────────┬──────────┘
                                       │ getMessages() → 取全量 → slice(-20) → 返回最近 20 条
                                       │ addMessage()  → 透传到内层（写入全量）
                            ┌──────────▼──────────┐
                            │  RedisChatHistory   │ ← 实际的 Redis 操作
                            │   RPUSH / LRANGE    │
                            └─────────────────────┘
```

**写全量、读窗口**：Redis 中保留完整记录（后续可异步持久化到数据库），模型只看到裁剪后的窗口。

**当前实现的一个性能优化点**：`getMessages()` 先 `LRANGE 0 -1` 取全量再在内存中 `slice(-N)`。如果单个会话消息量很大（数百条），可以优化为 `LRANGE key -N -1` 直接在 Redis 侧裁剪，减少网络传输。不过在本章的默认 TTL（1 小时）和典型对话频率下，单个会话通常不会超过几十条消息，当前实现已经足够。

### Redis 与数据库的一致性问题（架构预研）

本章只实现了 Redis 层，数据库持久化层留待后续。但在动手之前，必须先想清楚两层之间的一致性模型——否则后续实现时很容易踩坑。

#### 先建立完整的操作分类

现实中的 AI 产品普遍支持变更操作：

| 操作               | 描述                                   | 真实产品案例          | 数据行为                                               |
| ------------------ | -------------------------------------- | --------------------- | ------------------------------------------------------ |
| **追加消息** | 用户发消息 → AI 回复                  | 所有产品              | 追加 2 条（human + ai）                                |
| **删除消息** | 用户删除某条消息                       | 豆包、ChatGPT、Claude | 删除 1-N 条                                            |
| **重新生成** | 对 AI 最后一条回复不满意，重新生成     | 几乎所有产品          | 删除最后 1 条 AI 消息 + 追加新的 1 条                  |
| **编辑重发** | 修改之前某条用户消息，从该位置重新对话 | Gemini、ChatGPT       | 截断该消息之后的所有消息 + 更新该消息内容 + 追加新回复 |
| **清空会话** | 删除整个会话的所有消息                 | 所有产品              | 删除全部                                               |

可以看到，只有"追加消息"是 append-only 的。其余四种操作都涉及**删除或修改**——这意味着 Redis 和 DB 之间确实存在经典的缓存一致性问题。

接下来按操作频率和延迟敏感度，将它们分为两条路径：

```
┌─────────────────────────────────────────────────────────────────┐
│                     热路径 (Hot Path)        
│  追加消息 — 每次对话都触发，延迟敏感（在 LLM 调用的关键路径上）  
│  策略：Redis-first, Write-Behind 异步持久化到 DB   
│  原因：这是最高频操作，DB 写入不能出现在用户等待链路中   
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                     冷路径 (Cold Path)               
│  删除 / 重新生成 / 编辑重发 / 清空                     
│  — 用户主动触发，频率远低于对话（可能 100 次对话才 1 次删除）  
│  策略：DB-first, 再失效 Redis 缓存                         
│  原因：变更操作对一致性要求高（用户期望操作后立即看到正确结果），   
│        但对延迟容忍度更高（多几毫秒用户无感知）                  
└─────────────────────────────────────────────────────────────────┘
```

**核心设计思想：不同操作类型使用不同的一致性策略，而不是用一套策略强行覆盖所有场景**。这是一个混合一致性模型（Hybrid Consistency Model）。

#### 热路径：追加消息的 Write-Behind 策略

每次用户发送消息，`RunnableWithMessageHistory` 会将新的 HumanMessage + AIMessage 写入 Redis。这是最高频操作，需要极致的写入性能。

```
用户请求 → ① 写 Redis（RPUSH，<1ms）→ ② 发布持久化事件 → ③ 立即返回响应
                                              │
                                              ▼ （异步，与用户请求完全解耦）
                                    ④ BullMQ Worker → DB INSERT（3-10ms）
                                              │
                                              ├── 成功 → ACK
                                              └── 失败 → 指数退避重试（最多 3 次）
                                                          └── 仍失败 → Dead Letter Queue
```

**持久化窗口的风险**：从写入 Redis 到 DB 持久化完成之间，如果 Redis 宕机，这些消息会丢失。但 Redis 自身有 AOF 持久化（appendfsync everysec），极端情况下最多丢失 1 秒的数据。对于聊天场景这个风险通常可接受。

**NestJS 实现思路：**

```typescript
// 1. 对话完成后，发布事件（不阻塞响应）
@Injectable()
class LcelService {
  constructor(private eventEmitter: EventEmitter2) {}

  async memoryChat(dto: MemoryChatRequestDto) {
    const result = await chainWithHistory.invoke({ input: dto.input }, config);

    this.eventEmitter.emit('chat.message.created', {
      sessionId: dto.sessionId,
      userMessage: dto.input,
      aiMessage: result.content,
      timestamp: Date.now(),
    });

    return result;
  }
}

// 2. 事件监听器将任务推入 BullMQ 队列
@Injectable()
class ChatPersistenceListener {
  constructor(@InjectQueue('chat-persistence') private queue: Queue) {}

  @OnEvent('chat.message.created')
  async handleMessageCreated(payload: ChatMessageEvent) {
    await this.queue.add('persist-messages', payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    });
  }
}

// 3. BullMQ Worker 异步写入数据库
@Processor('chat-persistence')
class ChatPersistenceProcessor {
  @Process('persist-messages')
  async persist(job: Job<ChatMessageEvent>) {
    await this.messageRepo.save([
      { sessionId: job.data.sessionId, role: 'human', content: job.data.userMessage },
      { sessionId: job.data.sessionId, role: 'ai', content: job.data.aiMessage },
    ]);
  }
}
```

BullMQ 队列本身就运行在 Redis 上，不引入额外中间件。NestJS 的 `@nestjs/bullmq` 是成熟的一等公民。

#### 冷路径：变更操作的 DB-first + Cache Invalidation 策略

删除、编辑重发、重新生成、清空——这些操作的共同特征：

1. **用户主动触发**，不在 LLM 对话的关键路径上
2. **频率低**，偶尔才发生一次
3. **对一致性要求极高**——用户删了一条消息，下次对话时 AI 绝不能还"记得"那条消息的内容

对于这类操作，**DB 是唯一的权威数据源**。策略是：先更新 DB，再失效 Redis 缓存。

```
用户触发变更操作
       │
       ▼
  ① DB 执行变更（DELETE / UPDATE）← 同步，源头正确性保证
       │
       ▼
  ② Redis DEL session key ← 整个会话缓存失效（而非精确修改 List 中的某个元素）
       │
       ▼
  ③ 返回成功给客户端
       │
       ▼
  下一次对话请求进来时：
  → Redis Key 不存在（刚被删了）
  → 触发 Cache-Aside 读取：从 DB 加载最新状态 → 回填 Redis → 继续对话
```

**为什么用"失效整个 Key"而不是"精确修改 Redis List 中的某个元素"？**

Redis List 不支持按内容删除或按索引更新的原子操作（`LSET` 存在但需要知道精确索引，且并发不安全）。要精确修改 List，必须：读全量 → 内存中删除/修改 → 清空 List → 重新写入全部。这不仅复杂而且有并发风险。

相比之下，`DEL key` 是 O(1) 原子操作，简洁且绝对安全。代价仅是下一次对话请求会有一次 Cache Miss（从 DB 回填），这个一次性的冷读开销完全可以接受。

**各变更操作的具体 DB 操作：**

```typescript
// 删除消息
async deleteMessage(sessionId: string, messageId: string) {
  // ① DB: 删除指定消息
  await this.messageRepo.delete({ id: messageId, sessionId });
  // ② Redis: 失效缓存
  await this.redis.del(`${this.keyPrefix}${sessionId}`);
}

// 重新生成（删除最后一条 AI 消息，前端随后发起新的对话请求来获取新回复）
async regenerate(sessionId: string) {
  // ① DB: 删除该会话最后一条 role='ai' 的消息
  await this.messageRepo
    .createQueryBuilder()
    .delete()
    .where('id = (SELECT id FROM messages WHERE session_id = :sid AND role = :role ORDER BY created_at DESC LIMIT 1)',
      { sid: sessionId, role: 'ai' })
    .execute();
  // ② Redis: 失效缓存
  await this.redis.del(`${this.keyPrefix}${sessionId}`);
  // 前端收到成功后，发起新的 memoryChat 请求 → 触发 Cache Warming → LLM 基于新历史生成
}

// 编辑重发（Gemini 模式：修改指定消息，截断其后所有消息）
async editAndResend(sessionId: string, messageId: string, newContent: string) {
  // ① DB: 获取目标消息的时间戳
  const target = await this.messageRepo.findOneOrFail({ where: { id: messageId } });
  // ② DB: 删除该消息之后的所有消息
  await this.messageRepo
    .createQueryBuilder()
    .delete()
    .where('session_id = :sid AND created_at > :ts', { sid: sessionId, ts: target.createdAt })
    .execute();
  // ③ DB: 更新目标消息内容
  await this.messageRepo.update(messageId, { content: newContent });
  // ④ Redis: 失效缓存
  await this.redis.del(`${this.keyPrefix}${sessionId}`);
  // 前端收到成功后，发起新的 memoryChat 请求
}

// 清空会话
async clearSession(sessionId: string) {
  // ① DB: 删除所有消息
  await this.messageRepo.delete({ sessionId });
  // ② Redis: 失效缓存
  await this.redis.del(`${this.keyPrefix}${sessionId}`);
}
```

#### 读取路径：基于操作场景的数据源选择

| 读取场景             | 数据源                            | 延迟要求             | 数据范围          | 一致性   |
| -------------------- | --------------------------------- | -------------------- | ----------------- | -------- |
| LLM 对话链读取历史   | Redis → 未命中则 DB 回填         | 亚毫秒级（关键路径） | 最近 N 条（窗口） | 最终一致 |
| UI 展示完整历史      | 始终 DB                           | 50-200ms（可接受）   | 全量（分页）      | 强一致   |
| 变更操作后的首次对话 | DB → 回填 Redis（Cache Warming） | 一次性 5-15ms 开销   | 最近 N 条         | 强一致   |

**LLM 链读取（Cache-Aside 模式）**：

```
Redis Key 存在？ ──是──→ 从 Redis LRANGE 读取 → 窗口裁剪 → 注入 Prompt
      │
      否（Key 过期 / 被变更操作失效 / Redis 重启后丢失）
      │
      ▼
  从 DB 加载最近 N 条 → 写回 Redis（RPUSH + EXPIRE）→ 注入 Prompt
```

**UI 历史展示**：始终从 DB 按时间分页读取。Redis 中的数据是临时的（带 TTL），且没有分页语义，不适合做 UI 数据源。

#### 并发场景分析

**场景一：同一会话的快速连续请求**

用户在 AI 还没回复第一条消息时，快速发出了第二条消息：

```
请求 A（10:00:00.000）          请求 B（10:00:00.200）
  ├─ 读取 Redis 历史 [M1,M2]     ├─ 读取 Redis 历史 [M1,M2]  ← 读到相同的历史
  ├─ 调用 LLM（耗时 3s）          ├─ 调用 LLM（耗时 2s）
  ├─ 写回 [M3_human, M3_ai]      ├─ 写回 [M4_human, M4_ai]  ← 两者独立写入
  └─ Redis 最终: [M1,M2,M3h,M3a,M4h,M4a]  ← 消息都在，但 B 的 AI 回复不知道 A 的存在
```

**解决方案——分层防御：**

1. **前端 UX 防线（最有效）**：AI 回复期间禁用发送按钮。所有主流 AI 产品（ChatGPT、豆包、Claude）都这么做，从根源上避免并发
2. **服务端防线——Per-Session 分布式锁**（多设备同时使用同一会话时）：

```typescript
async memoryChat(dto: MemoryChatRequestDto) {
  const lockKey = `lock:chat:${dto.sessionId}`;
  const acquired = await this.redis.set(lockKey, '1', 'EX', 30, 'NX');

  if (!acquired) {
    throw new ConflictException('该会话正在处理中，请稍后再试');
  }

  try {
    return await this.doMemoryChat(dto);
  } finally {
    await this.redis.del(lockKey);
  }
}
```

**推荐**：前端 UX 防线 + 乐观策略。只有在明确需要多设备并发时才引入分布式锁。

**场景二：变更操作与对话请求并发**

用户在一个设备上删除消息，同时另一个设备正在用同一会话对话：

```
设备 A：删除消息 M3        设备 B：发送新消息
  ├─ DB DELETE M3            ├─ Redis 读取历史 [M1,M2,M3,M4]  ← 还能读到 M3！
  ├─ Redis DEL session key   ├─ LLM 基于含 M3 的历史回复
  └─ 完成                    └─ 写回 Redis [M1,M2,M3,M4,M5h,M5a]  ← M3 又回来了
```

这是一个典型的**竞态条件**。设备 A 删了 M3 并失效了 Redis，但设备 B 在失效之前已经读取了旧缓存，对话结束后又把含 M3 的完整历史写回了 Redis。

**解决方案——同一个 Per-Session 锁覆盖所有操作：**

变更操作也使用与对话相同的会话锁。这样变更操作和对话操作不会并发执行：

```typescript
// 变更操作同样获取会话锁
async deleteMessage(sessionId: string, messageId: string) {
  const lockKey = `lock:chat:${sessionId}`;
  const acquired = await this.redis.set(lockKey, '1', 'EX', 10, 'NX');
  if (!acquired) throw new ConflictException('该会话正在处理中');

  try {
    await this.messageRepo.delete({ id: messageId, sessionId });
    await this.redis.del(`${this.keyPrefix}${sessionId}`);
  } finally {
    await this.redis.del(lockKey);
  }
}
```

在实际产品中，多设备同时操作同一会话的概率极低，且前端通常有 WebSocket 推送来同步状态变更。所以这个锁更多是作为安全网存在。

**场景三：DB 持久化的有序性**

Write-Behind 方案中，多条消息异步入队持久化。只要每条消息自带时间戳（`createdAt`），DB 查询时按 `ORDER BY createdAt ASC` 排序，写入顺序就不影响读取顺序。这比用队列保序更简单也更可靠。

**场景四：Redis 与 DB 的数据完整性校验**

Redis 中有 10 条消息但 DB 中只有 8 条（2 条持久化失败了），怎么办？

```typescript
// 定时对账任务（Cron 5min），兜底机制，不影响主流程性能
@Cron('*/5 * * * *')
async reconcileSessions() {
  // 1. SCAN 所有活跃的 Redis 会话 Key
  // 2. 对每个 sessionId，比较 Redis LLEN 和 DB 中的消息计数
  // 3. Redis 消息数 > DB 消息数 → 从 Redis 读取缺失消息 → 补写到 DB
}
```

#### 完整的混合一致性模型总结

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         混合一致性模型 (Hybrid Consistency)  
│   
│  ┌─────────────────────────────────────────────────────────────────────────┐  
│  │ 热路径：追加消息 (Write-Behind)  
│  │  
│  │  Redis RPUSH (同步,<1ms) → Event → BullMQ → DB INSERT (异步,3-10ms)  
│  │  权威数据源：Redis（活跃会话期间）   
│  │  一致性级别：最终一致（毫秒~秒级延迟）   
│  └─────────────────────────────────────────────────────────────────────────┘   
│                           
│  ┌─────────────────────────────────────────────────────────────────────────┐   
│  │ 冷路径：变更操作 (DB-first + Cache Invalidation)   
│  │                        
│  │  DB 变更 (同步,3-15ms) → Redis DEL key (同步,<1ms) → 返回客户端   
│  │  权威数据源：DB（始终）   
│  │  一致性级别：强一致（操作完成即可见）  
│  └─────────────────────────────────────────────────────────────────────────┘   
│                                               
│  ┌─────────────────────────────────────────────────────────────────────────┐   
│  │ 读取路径                                   
│  │                                           
│  │  LLM 链读取：Cache-Aside（Redis → miss → DB 回填）   
│  │  UI 历史展示：直接 DB 读取（分页、强一致）       
│  └─────────────────────────────────────────────────────────────────────────┘   
│                                                               
│  ┌─────────────────────────────────────────────────────────────────────────┐   
│  │ 并发控制                                                       
│  │                                                                     
│  │  第一防线：前端 UX（AI 回复期间禁用发送）                      
│  │  第二防线：Per-Session Redis 分布式锁（覆盖对话 + 变更操作）   
│  │  兜底机制：定时对账 Cron + BullMQ Dead Letter Queue     
│  └─────────────────────────────────────────────────────────────────────────┘   
└─────────────────────────────────────────────────────────────────────────────────┘
```

#### 为什么这套方案是最佳实践？

1. **按场景分策略**：热路径追求极致性能（Write-Behind），冷路径追求绝对正确（DB-first）。而不是用一个折中方案强行覆盖所有操作
2. **技术栈统一**：BullMQ 底层就是 Redis，不引入 Kafka/RabbitMQ。NestJS 的 `@nestjs/bullmq` 是一等公民
3. **Cache Invalidation 而非 Cache Update**：变更操作直接 DEL key，避免复杂的 Redis List 精确修改，简洁且绝对正确。Cache Warming 在下一次请求时自动触发
4. **并发安全分层**：前端 UX + 服务端锁 + 定时对账，三层递进，避免过度工程
5. **关注点分离**：`RedisChatHistory` 只管快速读写，持久化和一致性逻辑独立在事件/队列/Cron 中，符合 SRP

### 提示模板对比

| 用途                 | 函数                         | 模板结构                                                                          |
| -------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| 无状态多轮           | `createChatPrompt()`       | `[SystemMessage?] → MessagesPlaceholder('messages')`                           |
| 单轮快速             | `createQuickChatPrompt()`  | `[SystemMessage?] → HumanMessage('{input}')`                                   |
| **有状态会话** | `createMemoryChatPrompt()` | `[SystemMessage?] → MessagesPlaceholder('history') → HumanMessage('{input}')` |

有状态会话模板的关键在于将 `history`（自动注入）和 `input`（当前输入）分离为两个独立的模板变量。

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

- ✅ **自行实现简单存储适配器**，避免为了 50 行逻辑引入 500+ 集成的巨型包
- ✅ **滑动过期（Sliding TTL）**：每次写入刷新 TTL，只要用户持续对话就不会过期
- ✅ **使用 SCAN 而非 KEYS** 遍历会话：KEYS 会阻塞 Redis 主线程
- ✅ **Pipeline 批量写入**：`addMessages()` 使用 ioredis pipeline 减少网络往返
- ✅ **装饰器模式实现窗口裁剪**：写全量保证完整性，读窗口控制 Token 预算
- ✅ **复用全局 ioredis 客户端**：ioredis 天然支持多路复用，无需为会话创建额外连接
- ✅ **明确 Redis 定位**：它是会话热缓存（短期工作记忆），不是消息的最终持久存储。消息的永久归档属于数据库的职责
- ❌ **避免在客户端同时维护 messages 和 sessionId**——两者互斥，混用会导致历史不一致
- ❌ **避免 windowSize 设置过大**：超出模型 context window 会被截断，浪费 Token
- ❌ **避免用 KEYS 命令扫描会话**：O(N) 阻塞操作，生产环境会拖慢所有 Redis 请求
- ❌ **避免将 Redis 当作唯一存储**：Redis 重启或 Key 过期后数据即丢失，生产环境必须有数据库兜底

### 本章实现的边界与后续演进

本章实现了生产级记忆管理的**基础层**（Redis 热缓存 + 滑动窗口）。一个完整的生产系统还需要：

| 能力                      | 本章状态  | 后续演进方向                                         |
| ------------------------- | --------- | ---------------------------------------------------- |
| Redis 会话热缓存          | ✅ 已实现 | —                                                   |
| 滑动窗口裁剪              | ✅ 已实现 | —                                                   |
| 滑动 TTL 过期             | ✅ 已实现 | —                                                   |
| 数据库持久化              | 📐 已设计 | Write-Behind + BullMQ 异步持久化，见"一致性问题"章节 |
| 缓存预热（Cache Warming） | 📐 已设计 | Redis Key 过期后从 DB 回填，见读取路径分析           |
| 并发控制                  | 📐 已设计 | 前端 UX 防线 + 可选 Per-Session 分布式锁             |
| 定时对账                  | 📐 已设计 | Cron 任务比较 Redis vs DB 消息数，补写缺失           |
| 服务端会话生命周期管理    | ❌ 未实现 | 接入用户系统后，由服务端生成 sessionId 并绑定用户，校验归属权限 |
| 摘要压缩                  | ❌ 未实现 | 窗口外消息用廉价模型生成摘要，拼在窗口前             |
| 持久用户记忆              | ❌ 未实现 | 从对话中提取用户事实，跨会话注入 System Prompt       |
| Token 级窗口控制          | ❌ 未实现 | 当前按消息条数裁剪，可升级为按 token 数裁剪          |

## 5. 行动导向 (Action Guide)

### Step 1: 实现 RedisChatHistory

**这一步在干什么**：实现 `BaseListChatMessageHistory` 抽象类，将对话消息以 `StoredMessage` JSON 格式存储到 Redis List 中。核心职责是封装 Redis 的 RPUSH（写入）、LRANGE（读取）、DEL（清除）操作，以及每次写入后的 TTL 刷新逻辑。

```typescript
// src/ai/memory/redis-chat-history.ts
import { BaseListChatMessageHistory } from '@langchain/core/chat_history';
import type { BaseMessage } from '@langchain/core/messages';
import {
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
} from '@langchain/core/messages';
import type Redis from 'ioredis';

export class RedisChatHistory extends BaseListChatMessageHistory {
  lc_namespace = ['langchain', 'stores', 'message', 'ioredis'];

  private readonly client: Redis;
  private readonly sessionKey: string;
  private readonly sessionTTL?: number;

  constructor(fields: {
    client: Redis;
    sessionKey: string;
    sessionTTL?: number;
  }) {
    super();
    this.client = fields.client;
    this.sessionKey = fields.sessionKey;
    this.sessionTTL = fields.sessionTTL;
  }

  async getMessages(): Promise<BaseMessage[]> {
    const raw = await this.client.lrange(this.sessionKey, 0, -1);
    const stored = raw.map(
      (item) => JSON.parse(item) as ReturnType<BaseMessage['toDict']>,
    );
    return mapStoredMessagesToChatMessages(stored);
  }

  async addMessage(message: BaseMessage): Promise<void> {
    const [serialized] = mapChatMessagesToStoredMessages([message]);
    await this.client.rpush(this.sessionKey, JSON.stringify(serialized));
    await this.refreshTTL();
  }

  async addMessages(messages: BaseMessage[]): Promise<void> {
    const serialized = mapChatMessagesToStoredMessages(messages);
    const pipeline = this.client.pipeline();
    for (const msg of serialized) {
      pipeline.rpush(this.sessionKey, JSON.stringify(msg));
    }
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
      await this.client.expire(this.sessionKey, this.sessionTTL);
    }
  }
}
```

### Step 2: 实现 WindowedChatHistory 装饰器

**这一步在干什么**：用装饰器模式包装任意 `BaseChatMessageHistory`，在读取时施加滑动窗口裁剪。写入侧全量持久化到底层存储（Redis），读取侧只返回最近 N 条消息，控制发送给模型的上下文长度。这种"写全量、读窗口"的分离设计，让我们可以在不丢失数据的前提下控制 Token 预算。

```typescript
// src/ai/memory/windowed-chat-history.ts
import { BaseChatMessageHistory } from '@langchain/core/chat_history';
import type { BaseMessage } from '@langchain/core/messages';

export class WindowedChatHistory extends BaseChatMessageHistory {
  lc_namespace = ['langchain', 'stores', 'message', 'windowed'];

  constructor(
    private readonly inner: BaseChatMessageHistory,
    private readonly windowSize: number,
  ) {
    super();
  }

  async getMessages(): Promise<BaseMessage[]> {
    const messages = await this.inner.getMessages();
    if (this.windowSize <= 0) return messages;
    return messages.slice(-this.windowSize);
  }

  async addMessage(message: BaseMessage): Promise<void> {
    return this.inner.addMessage(message);
  }

  async clear(): Promise<void> {
    return this.inner.clear();
  }
}
```

### Step 3: 实现 ChatHistoryFactory

**这一步在干什么**：作为 NestJS 可注入服务，按 sessionId 创建对话历史实例。它是 Redis 客户端、配置参数和 LangChain 抽象之间的桥梁——拼接 Redis Key（前缀 + sessionId）、注入已有的 ioredis 客户端（复用连接池）、根据 windowSize 决定是否包装 WindowedChatHistory 装饰器。

```typescript
// src/ai/memory/chat-history.factory.ts
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BaseChatMessageHistory } from '@langchain/core/chat_history';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from 'src/common/redis/redis.module';
import { RedisChatHistory } from './redis-chat-history';
import { WindowedChatHistory } from './windowed-chat-history';

@Injectable()
export class ChatHistoryFactory {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    configService: ConfigService,
  ) {
    // 从 ai.memory 配置中读取默认值
  }

  create(sessionId: string, options?: { ttl?: number; windowSize?: number }): BaseChatMessageHistory {
    const history = new RedisChatHistory({
      client: this.redis,
      sessionKey: `chat_history:${sessionId}`,
      sessionTTL: options?.ttl ?? 3600,
    });

    if ((options?.windowSize ?? 20) > 0) {
      return new WindowedChatHistory(history, options?.windowSize ?? 20);
    }
    return history;
  }
}
```

### Step 4: 构建 Memory 提示模板和链

**这一步在干什么**：在提示模板中加入 `MessagesPlaceholder('history')` 占位符，供 `RunnableWithMessageHistory` 自动注入 Redis 历史。与无状态模板的区别在于：无状态模板只有一个 `MessagesPlaceholder('messages')` 由客户端填充；有状态模板将 `history`（自动注入）和 `input`（当前用户输入）分离为两个独立变量。

```typescript
// src/ai/prompts/chat.prompts.ts（新增函数）
export function createMemoryChatPrompt(systemPrompt?: string): ChatPromptTemplate {
  const parts = [];
  if (systemPrompt) {
    parts.push(new SystemMessage(systemPrompt));
  }
  parts.push(new MessagesPlaceholder('history'));
  parts.push(['human', '{input}']);
  return ChatPromptTemplate.fromMessages(parts);
}
```

```typescript
// src/ai/chains/chat-chain.builder.ts（新增方法）
buildMemoryChatChain(model: BaseChatModel, systemPrompt?: string): PreparedMemoryChain {
  const prompt = createMemoryChatPrompt(systemPrompt);
  return {
    chain: prompt.pipe(model),
    inputMessagesKey: 'input',
    historyMessagesKey: 'history',
  };
}
```

### Step 5: 在 LcelService 中用 RunnableWithMessageHistory 包装

**这一步在干什么**：将 ChatChainBuilder 产出的管道与 ChatHistoryFactory 组合，用 `RunnableWithMessageHistory` 包装成有状态链。`RunnableWithMessageHistory` 是 LangChain 提供的装饰器，它在每次 `invoke`/`stream` 时自动：①从 Redis 加载历史 → ②注入到 prompt 的 `{history}` 占位符 → ③模型推理 → ④将新的一轮对话（用户消息 + AI 回复）写回 Redis 并刷新 TTL。

```typescript
// src/ai/lcel.service.ts（核心方法）
import { RunnableWithMessageHistory } from '@langchain/core/runnables';

private buildMemoryChain(model, dto): RunnableWithMessageHistory {
  const { chain, inputMessagesKey, historyMessagesKey } =
    this.chainBuilder.buildMemoryChatChain(model, dto.systemPrompt);

  return new RunnableWithMessageHistory({
    runnable: chain,
    getMessageHistory: (sessionId) =>
      this.chatHistoryFactory.create(sessionId, {
        ttl: dto.sessionTTL,
        windowSize: dto.maxHistoryLength,
      }),
    inputMessagesKey,
    historyMessagesKey,
  });
}

async memoryChat(dto: MemoryChatRequestDto): Promise<MemoryChatResponseDto> {
  const model = this.modelFactory.createChatModel(dto.provider, { ... });
  const chainWithHistory = this.buildMemoryChain(model, dto);
  const config = { configurable: { sessionId: dto.sessionId } };
  const result = await chainWithHistory.invoke({ input: dto.input }, config);
  // ... normalize and return
}
```

### Step 6: 注册模块与配置

**这一步在干什么**：在 AiModule 中注册新的 Provider，并在 ai.config.ts 中增加会话记忆的默认配置。配置项通过环境变量注入，支持不同环境使用不同的 TTL 和窗口大小。

```typescript
// src/ai/ai.module.ts（新增）
import { ChatHistoryFactory, SessionManagerService } from './memory';

providers: [
  // ... 已有
  ChatHistoryFactory,
  SessionManagerService,
],
```

```typescript
// src/common/configs/config/ai.config.ts（新增）
memory: {
  defaultSessionTTL: parseInt(process.env.AI_MEMORY_SESSION_TTL || '3600', 10),
  defaultWindowSize: parseInt(process.env.AI_MEMORY_WINDOW_SIZE || '20', 10),
  keyPrefix: process.env.AI_MEMORY_KEY_PREFIX || 'chat_history:',
},
```

### Step 7: 测试验证

```bash
# 1. 第一轮对话
curl -X POST http://localhost:3000/ai/lcel/memory/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"test-001","input":"你好，我叫张三"}'

# 2. 第二轮对话（验证记忆）
curl -X POST http://localhost:3000/ai/lcel/memory/chat \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"test-001","input":"我叫什么名字？"}'

# 3. 查看会话历史
curl http://localhost:3000/ai/lcel/memory/sessions/test-001

# 4. 列出所有会话
curl http://localhost:3000/ai/lcel/memory/sessions

# 5. 清除会话
curl -X DELETE http://localhost:3000/ai/lcel/memory/sessions/test-001
```
