# 阶段四：LangGraph 有状态智能体 — 章节设计蓝图

> 本文档是阶段四（047-054）的详细设计参考，每章开发时查阅。
> 目标：以 OpenClaw 级智能体为理解目标，从 0 掌握 Agent 核心概念与生产级实践。

## 设计背景

### 现有基座（038-046）

阶段三建立的 LangChain 能力栈：

- **多厂商模型工厂**：`AiModelFactory` + `IProviderAdapter` 适配器模式（038）
- **LCEL 管道**：`ChatChainBuilder` 6 种 build 方法，`prompt.pipe(model)` 声明式组合（041）
- **结构化输出**：Zod Schema + `withStructuredOutput`，`SchemaRegistry` 注册表（042）
- **工具调用**：`ToolRegistry` + `StructuredTool` + `ToolCallingLoop` 多轮循环引擎（043）
- **有状态会话**：`RedisChatHistory` + `WindowedChatHistory` + `RunnableWithMessageHistory`（044）
- **RAG**：自实现 `PgVectorStore` + Embedding 工厂 + 文档切块（045）
- **可观测性 & 韧性**：`LangChainTracer` 回调追踪 + `ResilienceService` 重试/降级 + 双层超时（046）
- **流式**：SSE 双协议（标准 + Vercel AI SDK UIMessageStream）（040）
- **异常处理**：`AiExceptionFilter` 统一映射（038）

### 预留骨架

`src/ai/agents/` 目录已预留：

```
agents/
├── agent.registry.ts        # AgentRegistry（register/get/getOrThrow）
├── index.ts
├── multi/index.ts            # 多智能体占位
├── single/index.ts           # 单智能体占位
└── shared/
    ├── states/index.ts       # 共享 State 占位
    ├── nodes/index.ts        # 共享 Node 占位
    └── tools/index.ts        # 共享 Tool 占位
```

### OpenClaw 参考架构

OpenClaw（200K+ GitHub Stars）是一个本地运行的开源 AI Agent 框架，其架构值得深度学习：

**Brain-Body-Soul 三层哲学**：
- **Brain（可租用的智能）**：LLM 模型可热切换，不影响其他层
- **Body（自有的执行）**：Gateway 控制面运行在本地硬件上，管理 shell、浏览器、文件 I/O、Skill 执行
- **Soul（持久化记忆）**：本地向量库、日志、长期记忆文件、人格定义

**4 层网关架构**：

| 层 | 职责 | 核心模式 |
|---|---|---|
| Gateway | 连接管理、路由、认证 | 单进程复用 |
| Integration | 平台归一化 | Channel Adapter |
| Execution | 任务排序、并发控制 | Lane Queue（per-session 串行） |
| Intelligence | Agent 行为、知识、主动性 | Skills + Memory + Heartbeat |

**核心创新模式**：
- **Lane Queue**：同一会话内任务严格串行，消除竞态条件
- **Skills-as-Markdown**：Skill 是 markdown 文件而非代码插件，Agent 可运行时自我编写新 Skill
- **Progressive Disclosure**：启动时只加载 Skill 名称/描述（~97字符/skill），激活时才注入完整内容
- **Heartbeat**：定时巡检 markdown 清单，实现主动式 Agent
- **Hybrid Search Memory**：向量 + 关键词双路检索（SQLite + FTS5 + sqlite-vec）

---

## 047. LangGraph 核心：状态图与图编排 (StateGraph Fundamentals)

### 定位

从 LCEL 链到 StateGraph 的范式转换。整个智能体阶段的地基。

### 核心内容

**1. 为什么需要 StateGraph**
- LCEL Chain = 线性管道（A → B → C），适合单链路任务
- StateGraph = 有限状态机（节点 + 条件边 + 循环），适合决策、分支、回退的智能体场景
- 关键差异：StateGraph 每一步都是可观测、可中断、可持久化的

**2. 三大原语**
- **State**（`StateSchema`）：共享数据快照
  - `MessagesValue`：内置消息 reducer（自动追加）
  - `ReducedValue`：自定义 reducer（累加器，解决并行节点写入冲突）
  - `UntrackedValue`：瞬态状态（不写入 checkpoint）
  - 多 Schema 模式：`InputState` / `OutputState` / `PrivateState` 分离
- **Node**（`GraphNode`）：纯函数，接收 State + config，返回 State 更新
- **Edge**：固定边（`addEdge`）和条件边（`addConditionalEdges` / `ConditionalEdgeRouter`）

**3. 两种 API 范式**
- **Graph API**（声明式）：`StateGraph` + `addNode` + `addEdge` + `compile`
- **Functional API**（过程式）：`entrypoint` + `task`
- 两者共享同一套持久化/中断机制，选择取决于场景偏好

**4. `task()` 原语初识**
- 副作用封装器：把 API 调用、文件写入等操作包进 `task()`
- 持久化恢复时能跳过已完成的 task 而不重复执行
- 为 049 章的 durable execution 做铺垫

**5. `contextSchema` 运行时注入**
- 在 compile 后通过 `config.context` 传入运行时配置
- 与 NestJS DI 的协作模式：NestJS 注入配置 → 通过 context 传给 LangGraph 图

**6. 第一个图：替代 ToolCallingLoop**
- 用 Graph API 实现 `model_node → shouldContinue → tool_node → model_node` 循环
- 对比 043 `ToolCallingLoop`（黑盒 while 循环）vs 047 StateGraph（显式状态机）
- 流式输出：Graph 级别的 streaming events

### 与现有基座的关系

- `AiModelFactory`、`ToolRegistry`、`StructuredTool` 直接复用
- `ToolCallingLoop` 被 StateGraph 替代为显式图，但保留作为简单场景的轻量方案
- `contextSchema` 为 NestJS ConfigService 与 LangGraph 图之间架起桥梁

---

## 048. 生产级 ReAct Agent (ReAct Agent with LangGraph)

### 定位

构建真正的 ReAct 智能体，理解 Agent 的核心思维循环。

### 核心内容

**1. ReAct 本质**
- Reasoning（LLM 思考下一步）+ Acting（执行工具）+ Observation（观察结果）的迭代循环
- 2026 数据：ReAct 在多步研究任务上成功率 78-85%（vs 零样本 42%）
- 适用场景：下一步依赖上一步结果的动态推理任务

**2. 从零自建 ReAct 图**
- `model_node → shouldContinue → tool_node → model_node` 循环
- 理解每个节点的职责和条件路由的判定逻辑
- 与 047 第一个图的差异：加入更完整的错误处理、最大迭代限制

**3. `createReactAgent` prebuilt 源码级拆解**
- LangGraph prebuilt 提供的开箱即用 ReAct Agent
- 源码解读：它在内部做了什么？与自建版本的差异在哪？
- 何时用 prebuilt，何时自建

**4. 2026 生产级增强模式**
- **Security Agent 安全拦截**：每个 Action 在执行前经过安全策略引擎审查
- **Contextual Compaction 上下文压缩**：长对话自动摘要早期步骤，保持上下文窗口在 32K 内
- **Parallel Reasoning Traces 替代思路评估**：生成 3 条替代思路，评估后选最优 Action

**5. MCP 协议意识**
- Model Context Protocol（Anthropic 提出的开放标准）= Agent 工具生态的 "USB-C"
- 统一的工具发现和调用接口，正在成为行业标准
- 当前项目的 ToolRegistry 已足够，MCP 作为未来工具体系的演进方向了解

**6. 与可观测性体系集成**
- `LangChainTracer` 的回调在 LangGraph 中同样通过 config.callbacks 自动传播
- Agent 级别的追踪：每个节点、每次工具调用都被记录

### 对比价值

048 完成后，清晰看到三个层次的工具调用：
1. 043 `ToolCallingLoop`：手写 while 循环，黑盒
2. 047 StateGraph 图：显式状态机，可观测但无完整 Agent 思维
3. 048 ReAct Agent：完整的 Thought-Action-Observation 循环，生产级

---

## 049. 持久化执行与线程管理 (Durable Execution & Thread Lifecycle)

### 定位

让 Agent 具备"断点续传"能力——崩溃恢复、长时运行、状态回溯。

### 核心内容

**1. 为什么 Agent 需要 Durable Execution**
- 区别于 044 的会话记忆（`RedisChatHistory` 存的是聊天消息）
- Checkpointer 存的是**图的完整执行状态**（当前节点、State 快照、中间结果）
- Agent 可能运行数分钟，期间可能遭遇 LLM 超时、网络故障、进程重启

**2. Durable Execution 三种模式**
- `sync`：每步同步写入 checkpoint，最高可靠性，有性能开销
- `async`：异步写入，高性能，但进程崩溃时可能丢失最后一步
- `exit`：仅退出时写入，最佳性能，但中间状态不保存
- 选型建议：开发用 sync，生产核心流程用 sync/async，高吞吐低风险用 exit

**3. Checkpointer 实现**
- `MemorySaver`：内存实现，开发调试用
- `PostgresSaver`（`@langchain/langgraph-checkpoint-postgres`）：生产用，复用项目已有 PostgreSQL
- 接口：`setup()` 初始化表结构，`thread_id` 作为主键
- JSONB 列存储序列化的 State 快照

**4. `task()` 持久化语义深入**
- 恢复执行时，从节点/entrypoint 起点重放
- 已完成的 `task()` 不重新执行，从持久化层读取缓存结果
- 要求 task 内操作具有幂等性
- 非确定性操作（随机数、当前时间）必须包进 task()

**5. Super-step 概念**
- 一个 super-step = 图的一次 "tick"，所有同步调度的节点在同一 super-step 执行
- Checkpoint 在每个 super-step 边界保存
- Time-travel 只能回溯到 super-step 边界

**6. Thread 生命周期管理**
- `thread_id`：一个 thread 对应一个独立的 Agent 执行上下文
- 同一 `thread_id` 的后续调用 = 在现有状态上继续执行
- 新 `thread_id` = 全新的空白状态

**7. Time-travel 调试**
- `getStateHistory()` 返回所有历史 checkpoint
- 可从任意历史状态点分叉执行
- `checkpoint_ns` 标识图/子图归属

**8. NestJS API 设计**
- 线程创建、状态查询、历史回溯端点

### 与现有基座的关系

- 复用项目已有的 PostgreSQL 连接
- 049 的 Thread 概念升级 044 的 Session 概念（Session = 聊天消息历史，Thread = 图执行状态）

---

## 050. 人机协同模式 (Human-in-the-Loop Patterns)

### 定位

在 Agent 执行链路中插入人工决策点——审批、编辑、验证。
OpenClaw 级智能体的关键差异：生产级 Agent 不是全自动的，高风险操作时暂停等待人类确认。

### 核心内容

**1. `interrupt()` 动态中断**
- 在任意节点/工具内暂停，传递 JSON 载荷给调用方
- 中断时 LangGraph 抛出特殊异常，被运行时捕获后保存状态
- 返回的 `__interrupt__` 字段包含中断载荷（用于前端渲染审批 UI）

**2. `Command({ resume })` 恢复**
- 人类决策后传回值，成为 `interrupt()` 的返回值
- 必须使用同一 `thread_id` 恢复
- 恢复时从节点起点重新执行（不是从 interrupt 那一行恢复）

**3. 四大核心模式**
- **审批 (Approve/Reject)**：`interrupt({ question, details })` → `Command({ resume: true/false })` → 条件路由到 proceed/cancel
- **编辑 (Review/Edit)**：暂停让人类修改 LLM 输出，修改后的内容作为 resume 值继续
- **验证 (Validate Input)**：循环 interrupt 直到输入合法
- **工具内中断 (Interrupt in Tools)**：直接在 tool 函数内调用 interrupt()，工具自带审批逻辑

**4. Command 从工具返回（新模式）**
- 工具内部返回 `Command({ update, goto })` 可以同时更新 State 和控制路由
- 工具不仅能返回结果，还能影响 Agent 执行流向

**5. 中断规则体系**
- ❌ 不可将 `interrupt()` 包在 try-catch 中（会捕获特殊异常）
- ❌ 不可条件性跳过 interrupt（索引匹配会错位）
- ❌ 不可传递不可序列化的值（函数、类实例）
- ✅ interrupt 前的副作用必须幂等（恢复时节点重新执行）
- ✅ 将副作用放在 interrupt 之后，或拆分为独立节点

**6. 多个并行中断**
- 并行分支各自 interrupt 时，通过 interrupt ID 映射 resume 值

**7. 分层审批框架（OpenClaw 启发）**
- 低风险操作：自动通过
- 中风险操作：异步通知
- 高风险操作：阻塞等待人工审批

**8. NestJS 端点设计**
- `POST /agents/:threadId/invoke` → 返回 `__interrupt__`
- `POST /agents/:threadId/resume` → 提交决策，继续执行

---

## 051. 高级 Agent 模式 (Advanced Agent Patterns)

### 定位

超越基础 ReAct，掌握 Agent 的三种高级思维模式及其选型。

### 核心内容

**1. Subgraph 模块化**
- 将复杂 Agent 拆分为可复用的子图（如"搜索子图"、"代码分析子图"）
- 子图可独立开发、测试、组合
- `checkpoint_ns` 隔离子图状态
- 子图与父图的通信：`Command({ graph: Command.PARENT })`

**2. Reflection 自我修正模式**
- Agent 执行后对结果做自评估，不满意则重新执行
- 实现：`execute_node → evaluate_node → (satisfied? → END : execute_node)`
- 场景：代码生成后自动 review、文档写作后自动修订

**3. Plan-and-Execute 模式**
- 两阶段：先让 LLM 生成任务计划列表，再逐步执行每个子任务
- 执行过程中可动态调整计划（re-plan）
- 适用场景：多步研究、复杂数据处理流水线

**4. 模式选型指南**
- ReAct（048）：下一步依赖上一步结果的动态推理
- Reflection：需要质量把关的生成任务（自循环改进）
- Plan-Execute：可预先分解的复杂多步任务
- 组合使用：Plan-Execute 的每个子任务内部可以是 ReAct Agent

---

## 052. 记忆体系与运行时扩展 (Memory & Runtime Extensibility)

### 定位

为 Agent 赋予跨会话记忆和运行时自我扩展的能力。

### 核心内容

**1. LangGraph Store 长期记忆**
- 与 044 `RedisChatHistory` 的区别：
  - `RedisChatHistory` = 单线程短期记忆（聊天消息），thread 内有效
  - `Store` = 跨线程长期记忆（用户画像、学到的规则），任意 namespace 可访问

- **三种记忆类型**：
  - **语义记忆 (Semantic)**：记住用户偏好、业务知识
    - Profile 模式：单个 JSON 文档持续更新
    - Collection 模式：多个小文档，语义检索
  - **情景记忆 (Episodic)**：记住过去的成功/失败经验，用作 few-shot 示例
  - **程序记忆 (Procedural)**：Agent 自我优化 prompt

- **写入时机**：
  - Hot-path（实时）：在 Agent 推理过程中写入，立即可用但增加延迟
  - Background（后台）：异步处理，不影响主流程延迟

**2. Lane Queue 模式（OpenClaw 核心创新）**
- 核心规则：同一会话内任务严格串行执行，不同会话间并行
- 从根本上消除 Agent 并发操作导致的竞态条件
- 实现概念：`Map<SessionKey, Task[]>`，per-session 队列
- 结构化 SessionKey：`workspace:channel:userId` 防止跨上下文泄漏
- 在 NestJS 中的实现：可作为 Guard 或 Interceptor 层

**3. Skills-as-Markdown 扩展模型（OpenClaw 启发）**
- Skill = markdown 文件（YAML frontmatter + 正文内容）
- 热重载：编辑文件后 Agent 下次推理自动生效
- Self-writing：Agent 可运行时创建自己的 Skill（程序记忆的具体体现）
- Progressive Disclosure：启动加载名称/描述，激活时注入完整内容

### 与现有基座的关系

- 044 `RedisChatHistory` = 短期记忆（thread 内），Store = 长期记忆（跨 thread），两者互补
- Lane Queue 复用 NestJS 中间件/拦截器机制
- Skills-as-Markdown 中的"程序记忆"是 Store 三种记忆类型的具体实现范例

---

## 053. 多智能体协作系统 (Multi-Agent Architecture)

### 定位

从单一 Agent 扩展到多个专业化 Agent 的协作网络。

### 核心内容

**1. Supervisor 模式**
- 中央 "调度员" Agent 分析任务 → 分配给专业 Agent → 汇总结果
- `@langchain/langgraph-supervisor` 官方包提供 `createSupervisor()` 开箱即用
- 同时教"用 prebuilt"和"从零自建"
- Supervisor 自身也是一个 LLM Agent，用推理能力决定任务路由

**2. Handoff 模式**
- Agent 之间直接转移任务控制权，无需中央调度
- 底层机制：`Command({ goto: "target_agent", graph: Command.PARENT })` 从子图路由到父图节点
- 适合流程固定的场景（如"客服Agent → 技术支持Agent → 售后Agent"）

**3. Subgraph 嵌套**
- 每个 Agent 实现为一个子图，由父图编排
- `checkpoint_ns` 隔离各 Agent 的状态
- 子图 interrupt 会传播到父图

**4. 状态共享与隔离**
- 全局 State：所有 Agent 共享（通过父图 State）
- 消息传递：Agent 间通过 messages 通信
- Store：跨 Agent 的长期记忆共享（namespace 隔离）

**5. OpenClaw 架构深度剖析**
- **Brain-Body-Soul 哲学**：可租用的智能 vs 自有的执行和记忆
- **Gateway 核心**：Agent 本质是一个网关问题，不是模型问题
- **Channel Adapter**：多平台归一化（29+ 消息平台）
- **Pi Agent Framework**：核心 Agent 循环委托给专门的框架
- **与 LangGraph 的映射**：
  - OpenClaw Skill ≈ LangGraph Subgraph + Tool
  - OpenClaw Lane Queue ≈ NestJS per-session 串行中间件
  - OpenClaw Memory ≈ LangGraph Store + Checkpointer

**6. NestJS AgentRegistry 升级设计**
- 从当前的占位骨架升级为完整的多 Agent 注册/发现/调度体系
- Agent 定义：name、description、tools、graph、capabilities
- 动态路由：Supervisor 根据 Agent 描述选择最佳 Agent

---

## 054. 生产级 Agent 运维与治理 (Production Agent Operations)

### 定位

让 Agent 从"能跑"到"能上线"——运维、安全、成本、评估全覆盖。

### 核心内容

**1. 异步长时运行 Agent**
- Agent 任务可能持续数分钟，不能阻塞 HTTP 请求
- 设计模式：`POST /agents/run` 返回 taskId → 轮询状态 / WebSocket 推送
- Durable Execution 模式选型（运维角度）：
  - 核心业务流程：`sync` 模式确保不丢状态
  - 高吞吐辅助任务：`async` 或 `exit` 模式

**2. Agent 事件流 → NestJS SSE**
- 将 LangGraph 的 streaming events 适配到 NestJS SSE 端点
- 与 040 `AiStreamAdapter` 体系集成
- 实时推送：节点进入/退出、工具调用开始/结束、中间结果

**3. Circuit Breaker 熔断保护**
- 防止 Agent 陷入工具调用死循环
- 触发条件：连续 N 次失败、Token 消耗超阈值、执行时间超限
- 触发后：中止执行，返回部分结果 + 错误上下文

**4. Contextual Compaction 上下文压缩**
- 长时运行 Agent 的消息历史持续增长
- 策略：当 token 计数超过阈值时，摘要早期步骤
- 与 044 `WindowedChatHistory` 的关系：滑动窗口是简单版，Compaction 是智能版（用 LLM 生成摘要）

**5. 成本控制：Token 预算守卫**
- 单次 Agent 执行的 Token 上限
- 按用户/按日的配额管理
- 在 LangChainTracer 中实时统计 token，超限时 abort

**6. 安全护栏 (Guardrails)**
- **Security Agent 拦截层**：每个 Action 在执行前经过安全策略审查
- **输入过滤**：拒绝恶意指令（prompt injection 防御）
- **输出审查**：防止敏感信息泄漏
- **工具权限边界**：Agent 只能调用被授权的工具
- **Agent 隔离**：独立执行环境、独立资源限制

**7. MCP 工具生态标准化**
- Docker MCP Toolkit 提供容器化 MCP Server 部署
- MCP Gateway 做路由、认证、密钥管理
- Token 效率：少量宽能力工具优于大量窄能力工具

**8. 评估指标体系**
- 任务完成率（目标达成 vs 超时/失败）
- 工具调用准确率（有效调用 vs 无效调用）
- 平均迭代次数（效率指标）
- 延迟分布（P50/P95/P99）
- Token 消耗/成本追踪

**9. 与 046 可观测性体系的深度集成**
- `LangChainTracer` 在 LangGraph 中的使用（回调在图中同样自动传播）
- Agent 级 TraceSummary：扩展 `TraceSpan` 支持 node_enter/node_exit/interrupt 事件
- 指标导出到 Prometheus/Grafana（L2 层级，参见 046 的 4 层可观测性模型）

---

## 学习路径递进逻辑

```
047 地基层 → StateGraph 基本功，两种 API 范式，替代 ToolCallingLoop
 ↓
048 核心层 → 构建第一个真正的 Agent（ReAct），理解 Agent 思维循环
 ↓
049 持久层 → Durable Execution，Checkpointer，断点续传，Time-travel
 ↓
050 协作层 → 人类参与 Agent 决策循环，审批/编辑/验证模式
 ↓
051 模式层 → Subgraph / Reflection / Plan-Execute 高级 Agent 模式
 ↓
052 记忆层 → Store 长期记忆 + Lane Queue 串行队列 + Skills 扩展
 ↓
053 多体层 → 从单 Agent 到 Agent 网络，Supervisor/Handoff/Subgraph
 ↓
054 治理层 → 生产运维、安全护栏、成本控制、评估指标
```

每一章在前一章基础上叠加一个新维度，每章 3-4 个紧密关联的主题，与阶段三的章节密度一致。

### 章节密度评审

| 章节 | 子主题数 | 内聚类型 | 评估 |
|------|---------|---------|------|
| 047 | 6 | 同一概念递进（StateGraph 原语 → API → 实践） | ✅ 合理 |
| 048 | 6 | 同一概念递进（ReAct 原理 → 自建 → prebuilt → 增强） | ✅ 合理 |
| 049 | 8 | 深但窄（全部是"持久化"的不同切面） | ✅ 可接受 |
| 050 | 8 | 深但窄（全部是 interrupt/resume 机制的不同应用） | ✅ 可接受 |
| 051 | 4 | 三种模式 + 选型指南 | ✅ 理想 |
| 052 | 3 | 三个围绕"持久状态与扩展"的主题 | ✅ 理想 |
| 053 | 6 | 三种协作模式 + 状态管理 + 参考架构 | ✅ 合理 |
| 054 | 9 | 广度型总览（每个子主题 3-5 要点，多为已有能力的延伸） | ⚠️ 偏重但可接受 |

**054 保持不拆分的决策依据**：
- 054 的"多"是**广度多而非深度多**——每个子主题平均仅 3 个要点，是"模式 + 配置"而非"从零架构"
- 多数主题是已有能力的延伸（SSE 复用 040、Compaction 延伸 044、可观测集成延伸 046），实际新增量有限
- "运维总览"章节天然是广度型的，拆开会失去"生产就绪检查清单"的全局视角
- 实际设计篇幅（~58 行）与 049（~53 行）相当，内容量并未失控

---

## 技术调研来源

- LangGraph.js 官方文档（Graph API / Functional API / Interrupts / Persistence / Durable Execution / Memory）
- OpenClaw 架构分析（Brain-Body-Soul、4 层网关、Lane Queue、Skills-as-Markdown）
- 2026 Agent 生产实践（ReAct 增强模式、Security Agent、Contextual Compaction、MCP 标准化）
- `@langchain/langgraph-supervisor` 多智能体库
