# 053. 多智能体协作系统 (Multi-Agent Architecture)

## 1. 核心问题与概念 (The "Why")

### 解决什么问题

单 Agent 的局限性在复杂任务面前逐渐暴露：

- **能力瓶颈**：一个 Agent 承载所有工具和提示词，prompt 臃肿、推理质量下降
- **职责模糊**：通用 Agent 无法在所有领域都表现优秀
- **扩展困难**：新增能力需修改现有 Agent，违反开闭原则

多智能体架构将**单一 Agent 拆分为多个专业化 Agent**，由 Supervisor 编排协作：

```
单 Agent:  用户 → [通用 Agent（10 个工具 + 巨大 prompt）] → 回复

多 Agent:  用户 → [Supervisor] → [Research Agent（2 个工具）]
                               → [Code Agent（1 个工具）]
                               → 汇总回复
```

### 核心概念


| 概念                       | 定义                                   | 本项目对应                                    |
| ------------------------ | ------------------------------------ | ---------------------------------------- |
| **Supervisor**           | 中央编排 Agent，分析任务并路由到专业 Agent（协调者/管理者） | `createSupervisor`（官方预构建）                |
| **Sub-Agent**            | 专业化执行 Agent，配备特定工具和提示词               | `buildResearchAgent` / `buildCodeAgent`  |
| **Handoff**              | Agent 之间的任务转移机制                      | `transfer_to_<name>` 工具 + `Command` 跨图路由 |
| **Checkpoint Namespace** | 子图的状态隔离机制                            | LangGraph 自动为 subgraph 分配独立命名空间          |


### 依赖关系


| 包                                 | 角色                                                |
| --------------------------------- | ------------------------------------------------- |
| `@langchain/langgraph-supervisor` | 官方 Supervisor 预构建库（createSupervisor + Handoff 工具） |
| `langchain`                       | createAgent — LangChain v1 标准 Agent 构建 API          |
| `@langchain/langgraph`            | 核心图引擎（StateGraph, Command, CompiledStateGraph）     |
| `@langchain/core`                 | 消息类型、工具接口                                         |


## 2. 核心用法 / 方案设计 (Usage / Design)

### 场景 A: Supervisor 编排 — 跨域复合任务

用户提出需要多种能力的复合任务，Supervisor 自动拆分并委派：

```typescript
import { createSupervisor } from '@langchain/langgraph-supervisor';
import { createAgent } from 'langchain';

// 1. 创建专业化子 Agent（带 name 属性，Supervisor 据此生成 Handoff 工具）
//    createAgent 返回 ReactAgent，通过 .graph 获取 CompiledStateGraph
const researchAgent = createAgent({
  model,
  tools: [weatherTool, timeTool],
  name: 'research_agent',
  systemPrompt: 'You are a research specialist...',
});

const codeAgent = createAgent({
  model,
  tools: [calculateTool],
  name: 'code_agent',
  systemPrompt: 'You are a code and math specialist...',
});

// 2. 创建 Supervisor（自动生成 transfer_to_research_agent / transfer_to_code_agent）
//    agents 参数需要 CompiledStateGraph，通过 .graph 获取
const workflow = createSupervisor({
  agents: [researchAgent.graph, codeAgent.graph],
  llm: model,
  prompt: 'You are a team supervisor...',
  outputMode: 'full_history',
});

// 3. 编译并执行
const app = workflow.compile();
const result = await app.invoke({
  messages: [{ role: 'user', content: '查北京天气，算温度变化' }],
});
```

### 场景 B: 按需启用子 Agent

生产场景中并非所有请求都需要全部 Agent，支持按需启用降低不必要的 LLM 路由开销：

```typescript
// 仅启用 research_agent
const result = await multiAgentService.invoke({
  provider: 'siliconflow',
  model: 'Pro/MiniMaxAI/MiniMax-M2.5',
  messages: [{ role: 'user', content: '北京天气怎么样？' }],
  enabledAgents: ['research_agent'],
});
```

### 场景 C: 定制 Supervisor 路由策略

通过 `systemPrompt` 注入额外路由指令：

```typescript
const result = await multiAgentService.invoke({
  // ...
  systemPrompt: '优先使用 research_agent 获取信息，仅在明确需要计算时才使用 code_agent',
});
```

## 3. 深度原理与机制 (Under the Hood)

### 3.1 Command：贯穿 HITL 与 Handoff 的统一原语

在阅读 Handoff 之前，先回顾一个关键事实：**Handoff 不是一个新概念，它和 050 HITL 章节的 `interrupt()` / `Command({ goto })` 共享同一个底层机制**。

LangGraph 的 `Command` 对象是图中**所有动态控制流转移**的唯一原语。无论是人审批后跳转节点，还是 Supervisor 把任务交给子 Agent，底层都是同一个东西：

```
050 HITL:        Command({ goto: 'executeTools' })       // 人审批通过 → 跳到工具执行节点
050 HITL:        Command({ resume: decision })            // 恢复被 interrupt() 暂停的节点

053 Multi-Agent: Command({ goto: 'research_agent' })     // Supervisor → 把任务交给 research_agent
053 Multi-Agent: Command({ goto: 'supervisor' })          // research_agent 完成 → 把结果交回 Supervisor
```

区别仅在于一个参数 `graph`：


| 场景                | Command 用法                                                   | graph 参数         | 含义                       |
| ----------------- | ------------------------------------------------------------ | ---------------- | ------------------------ |
| **HITL** (050)    | `Command({ goto: 'executeTools' })`                          | 省略（默认当前图）        | 在**同一个图内**跳转节点           |
| **Handoff** (053) | `Command({ goto: 'research_agent', graph: Command.PARENT })` | `Command.PARENT` | **跨越子图边界**，在父图级别路由到另一个节点 |


所以 Handoff 的本质是：**`Command` + `graph: Command.PARENT` = 跨图控制权转移**。

#### Command 的底层运行时机制

Command 在代码层面是一个普通的类实例，但 LangGraph 运行时对它有特殊处理。理解这个处理机制需要知道 LangGraph 的**异常冒泡架构**。

**所有"非正常边"的控制流都基于异常实现**。LangGraph 源码中有一个共同基类：

```
GraphBubbleUp (extends Error)         ← 所有非正常控制流的基类
  ├── GraphInterrupt                  ← interrupt() 抛出此异常暂停执行
  └── ParentCommand                   ← Command({ graph: PARENT }) 触发此异常跨图路由
```

050 HITL 的 `interrupt()` 和 053 的跨图 Handoff 共享同一个异常冒泡机制，只是异常类型不同。

**场景 1：同图内路由（无 `graph` 参数）**

节点返回 `Command({ goto: 'nodeB', update: { ... } })` 时，运行时的处理流程：

```
节点执行完毕，返回值 = Command 实例
           │
           ▼
运行时检测: isCommand(returnValue) === true
           │
           ▼
提取 update: command._updateAsTuples()
  → 转换为 PendingWrite[] 元组：[['messages', msg1], ['count', 3]]
  → 写入 State Channel（和普通节点返回值走同一条路径）
           │
           ▼
提取 goto: command.goto === 'nodeB'
  → 替代正常的边路由逻辑，直接将 'nodeB' 作为下一个执行节点
           │
           ▼
执行 nodeB
```

关键点：**在同图内，Command 不抛异常**。运行时直接从返回值中提取 `update` 和 `goto`，本质上是"把状态更新和路由决策打包成一个原子操作"。

**场景 2：跨图路由（`graph: Command.PARENT`）**

当节点或工具返回 `Command({ goto: 'target', graph: Command.PARENT })` 时，运行时的处理完全不同：

```
子图内的节点/工具返回 Command({ graph: Command.PARENT })
           │
           ▼
运行时检测到 graph === Command.PARENT
           │
           ▼
将 Command 包装成 ParentCommand 异常并抛出:
  throw new ParentCommand(command)
           │
           ▼                              ← 异常冒泡！
ParentCommand extends GraphBubbleUp extends Error
  → 异常沿调用栈向上冒泡
  → 穿越子图边界
  → 被父图的运行时 catch 捕获
           │
           ▼
父图运行时: isParentCommand(error) === true
  → 提取 command.update → 写入父图 State Channel
  → 提取 command.goto → 在父图级别路由到目标节点
           │
           ▼
父图执行目标节点（如 research_agent）
```

**和 050 interrupt() 的底层对比**：

```
interrupt():
  → throw new GraphInterrupt(interrupts)      // GraphBubbleUp 子类
  → 运行时 catch → 保存 checkpoint → 返回 __interrupt__ 给调用方
  → 等待外部 Command({ resume }) 恢复

Command({ graph: PARENT }):
  → throw new ParentCommand(command)           // GraphBubbleUp 子类
  → 父图运行时 catch → 提取 update + goto → 路由到目标节点
  → 立即继续执行（无暂停）
```

两者的差异：

| 维度 | interrupt() | Command({ graph: PARENT }) |
|------|-------------|---------------------------|
| 异常类型 | `GraphInterrupt` | `ParentCommand` |
| 共同基类 | `GraphBubbleUp` | `GraphBubbleUp` |
| 被谁捕获 | 当前图运行时 | 父图运行时 |
| 捕获后行为 | 保存 checkpoint，**暂停**执行 | 提取 goto，**立即**路由到目标节点 |
| 是否需要外部输入 | 是（等待 `resume`） | 否（自动继续） |

这解释了为什么 LangGraph 能用同一套引擎同时支持 HITL 和 Multi-Agent：**两者都是"抛异常 → 运行时捕获 → 做不同的事"**，只是捕获后的处理逻辑不同。

### 3.2 Handoff 是什么：把 Command 包装成工具

理解了 Command 是控制流原语之后，Handoff 就很容易理解了。

**核心问题**：Supervisor 是一个 LLM Agent。LLM 不能直接操纵图的运行时——它唯一能做的事情就是"调用工具"。那么如何让 LLM 告诉运行时"我想把任务交给 research_agent"？

**Handoff 的解法**：把 `Command` 包装成一个工具。LLM 调用这个工具时，工具返回的不是普通结果，而是一个 `Command` 对象。LangGraph 运行时识别到返回值是 Command，就执行路由跳转。

```
没有 Handoff 的世界（不可行）:
  LLM: "我决定交给 research_agent"    →  ???  运行时无法感知 LLM 的意图

有 Handoff 的世界:
  LLM: tool_call: transfer_to_research_agent()
    ↓
  工具执行: return new Command({ goto: 'research_agent', graph: Command.PARENT })
    ↓
  运行时: 收到 Command → 路由到 research_agent 节点
```

这就是 Handoff 工具在 `@langchain/langgraph-supervisor` 内部的核心实现：

```typescript
// createSupervisor 遍历传入的 agents 数组，为每个 agent 自动生成一个这样的工具
const handoffTool = tool(
  async (_, config) => {
    // 返回 ToolMessage（满足 LLM 工具调用的消息协议）
    const toolMessage = new ToolMessage({
      content: `Successfully transferred to ${agentName}`,
      tool_call_id: config.toolCall.id,
    });

    // 关键：返回 Command 而非普通字符串
    // 运行时检测到返回值是 Command 类型，执行路由跳转
    return new Command({
      goto: agentName,                                        // 目标子 Agent 节点
      graph: Command.PARENT,                                  // 在父图级别路由（跨子图边界）
      update: { messages: state.messages.concat(toolMessage) }, // 路由同时原子更新消息历史
    });
  },
  { name: `transfer_to_${agentName}`, schema: z.object({}) },
);
```

用一句话总结：**Handoff = 把"跨图 Command"包装成"LLM 可调用的工具"，从而将 LLM 的工具调用能力桥接到 LangGraph 的图路由能力**。

### 3.3 Handoff 完整生命周期

理解了 Handoff 的本质后，看完整的一次委派-返回循环：

```
用户: "查北京天气，算一周后温度"

第 1 步：Supervisor 接收请求
  ┌─────────────────────────────────────────────────────────────────
  │  supervisor 节点（ReAct Agent）                                 
  │  LLM 工具箱: [transfer_to_research_agent, transfer_to_code_agent]
  │                                                                 
  │  LLM 推理: "需要先查天气 → 调用 transfer_to_research_agent"       
  │  输出: tool_call: transfer_to_research_agent()                  
  └─────────────────────────────┬───────────────────────────────────
                                │
                                ▼
第 2 步：Handoff 工具执行，产生 Command
  ┌─────────────────────────────────────────────────────────────────┐
  │  transfer_to_research_agent 工具执行                             
  │  return new Command({                                           
  │    goto: 'research_agent',    ← 目标节点                         
  │    graph: Command.PARENT,     ← 告诉运行时：在父图级别路由        
  │    update: { messages: [...] } ← 携带对话上下文                  
  │  })                                                             
  └─────────────────────────────┬───────────────────────────────────┘
                                │
                                ▼
第 3 步：运行时路由到 research_agent 子图
  ┌─────────────────────────────────────────────────────────────────┐
  │  research_agent 子图（独立的 ReAct 循环）                         
  │  LLM 工具箱: [get_weather, get_current_time]                     
  │                                                                 
  │  LLM: tool_call: get_weather({ city: '北京' })                  
  │  工具返回: "北京 15°C，晴"                                       
  │  LLM: "北京当前气温 15°C"                                        
  └─────────────────────────────┬───────────────────────────────────┘
                                │
                                ▼
第 4 步：Handoff Back — 子 Agent 自动交还控制权
  ┌─────────────────────────────────────────────────────────────────
  │  research_agent 执行完毕后，LangGraph 自动注入                     
  │  "handoff back" 消息对:                                          
  │                                                                 
  │  AIMessage:   tool_calls: [{ name: 'transfer_back_to_supervisor' }] 
  │  ToolMessage: "Successfully transferred back to supervisor"     
  │                                                                 
  │  这对消息让 Supervisor LLM 知道"research_agent 完成了，             
  │  我现在重新获得了控制权"                                            
  └─────────────────────────────┬───────────────────────────────────
                                │
                                ▼
第 5 步：Supervisor 审查结果，决定下一步
  ┌─────────────────────────────────────────────────────────────────┐
  │  supervisor 节点（第二轮）                                        
  │  LLM 看到 research_agent 返回的天气信息                            
  │  LLM 推理: "还需要计算温度变化 → transfer_to_code_agent"           
  │  ... 重复第 2-4 步 ...                                          
  │                                                                 
  │  最终 LLM 推理: "信息充足，直接回复用户"                             
  │  输出: "北京当前 15°C，每天升 2°C，一周后 15+14=29°C"               
  │  （无 tool_call → 运行时走向 END）                                
  └─────────────────────────────────────────────────────────────────┘
```

对照 050 HITL 的控制流转移，关键差异一目了然：


| 维度              | 050 HITL                        | 053 Handoff                    |
| --------------- | ------------------------------- | ------------------------------ |
| **谁发出 Command** | 代码节点（reviewToolCalls）           | 工具函数（transfer_to_X）            |
| **谁决定跳转目标**     | 代码逻辑（if approve → executeTools） | LLM（选择调用哪个 transfer 工具）        |
| **跨图吗**         | 否（同一图内跳转）                       | 是（`graph: Command.PARENT` 跨子图） |
| **有暂停吗**        | 是（interrupt 等待人类输入）             | 否（纯自动化委派）                      |
| **返回机制**        | Command({ resume })             | Handoff Back 消息对（自动注入）         |


### 3.4 Supervisor 执行流程总览

```
┌──────────────────────────────────────────────────────────────┐
│                     Supervisor Graph（父图）                  │
│                                                              │
│  ┌───────┐   ┌────────────┐   ┌──────────────────────┐       │
│  │ START │─▶│ supervisor │─▶│ 有 tool_call 吗?      │       │
│  └───────┘   │ (ReAct LLM)│   └──────────┬───────────┘       │
│              └────────────┘              │                   │
│                    ▲           ┌─────────┼──────────┐        │
│                    │    transfer_to_X    │    无 tool_call   │
│                    │           │         │          │        │
│                    │           ▼         ▼          ▼        │
│                    │     ┌──────────┐ ┌────────┐ ┌──────┐    │
│   Handoff Back ────┘     │ Research │ │  Code  │ │ END  │    │
│   (自动注入消息对)        │  Agent   │ │ Agent  │ │      │    │
│                          │ (子图)   │ │ (子图) │  └──────┘    │
│                          └──────────┘ └────────┘             │
└──────────────────────────────────────────────────────────────┘
```

### 3.5 Checkpoint Namespace 隔离

每个子 Agent 以子图（subgraph）形式嵌入父图。LangGraph 自动为子图分配独立的 checkpoint 命名空间：

```
Parent Graph:    thread_id = "abc-123"
  ├─ supervisor:      checkpoint_ns = ""                    (根命名空间)
  ├─ research_agent:  checkpoint_ns = "research_agent"      (自动分配)
  └─ code_agent:      checkpoint_ns = "code_agent"          (自动分配)
```

隔离效果：

- 子 Agent 的内部 State（tool 调用次数、迭代计数）不污染父图 State
- 子 Agent 的 checkpoint 独立存储，不与父图 checkpoint 混合
- 父图只关心子 Agent 最终返回的消息，子 Agent 内部多少轮 ReAct 循环对父图透明

### 3.6 OpenClaw Brain-Body-Soul 架构映射

OpenClaw 的架构哲学与本项目的映射：


| OpenClaw 层 | 哲学                | 本项目对应                                                  |
| ---------- | ----------------- | ------------------------------------------------------ |
| **Brain**  | 可租用的智能 — LLM 可热切换 | `AiModelFactory` + 多厂商适配                               |
| **Body**   | 自有的执行 — 网关、工具、I/O | `ToolRegistry` + Agent 图 + NestJS 控制面                  |
| **Soul**   | 持久化记忆             | `MemoryStoreService` (052) + `CheckpointService` (049) |


OpenClaw 核心创新模式在本项目的体现：


| OpenClaw 模式                | 本项目实现                      |
| -------------------------- | -------------------------- |
| Lane Queue（per-session 串行） | `LaneQueueService` (052)   |
| Skills-as-Markdown         | `SkillLoaderService` (052) |
| Channel Adapter（多平台归一化）    | `IProviderAdapter` (038)   |
| Supervisor 编排              | `MultiAgentService` (053)  |


### 3.7 延迟分析：Multi-Agent 的性能本质

#### 实测数据

请求参数：
```json
{
  "provider": "siliconflow",
  "model": "Pro/MiniMaxAI/MiniMax-M2.5",
  "messages": [{ "role": "user", "content": "帮我查一下北京现在的天气和当前时间" }],
  "enabledAgents": ["research_agent"]
}
```

响应指标：
```json
{
  "agentCalls": { "research_agent": 1 },
  "totalDelegations": 1,
  "trace": {
    "totalLatencyMs": 30919,
    "llmCallCount": 4,
    "totalTokens": 2856
  }
}
```

#### 延迟拆解

任务"查天气 + 查时间"，实际执行链路如下。每一行是一次 **串行的远程 LLM 调用**，无法并行：

```
时间轴  ├────── ~8s ──────┼────── ~8s ──────┼────── ~8s ──────┼────── ~8s ──────┤
        │                 │                 │                 │                 │
步骤    │  Supervisor      │ research_agent  │ research_agent  │  Supervisor     │
        │  路由决策         │ 调 get_weather   │ 调 get_time     │  综合回复        │
        │                 │                 │                 │                 │
LLM调用  │  第 1 次          │  第 2 次         │  第 3 次         │  第 4 次         │
        │                 │                 │                 │                 │
产出    │  transfer_to_   │  AIMessage      │  AIMessage      │  最终响应        │
        │  research_agent │  + tool_call    │  + tool_call    │  (含具体数据)    │
```

**31 秒 = 4 次串行 LLM 调用 × ~8s/次**。这不是代码浪费，而是 Multi-Agent 架构的固有成本。

#### 延迟来自哪里

| 环节 | 耗时占比 | 能优化吗 |
|------|---------|---------|
| **远程 API 往返**（SiliconFlow 网络延迟 + 模型推理） | ~95% | 换更快的 API / 模型 |
| **Supervisor 路由开销**（多出 1 次 LLM 调用） | ~25% | 简单任务直接用单 Agent 跳过路由 |
| **序列化工具调用**（模型逐个调用工具，不支持并行） | ~25% | 换支持并行 tool calling 的模型 |
| **图运行时开销**（Command 路由、状态更新、消息拼接） | <1% | 不需要优化 |

#### 对比：单 Agent vs Multi-Agent

同样的任务"查天气 + 查时间"：

```
单 Agent (直接 ReAct):
  LLM call 1: 调 get_weather     → ~8s
  LLM call 2: 调 get_current_time → ~8s
  LLM call 3: 生成最终回复         → ~8s
  总计: 3 次 LLM 调用, ~24s

Multi-Agent (Supervisor 编排):
  LLM call 1: Supervisor 路由      → ~8s  ← 额外开销
  LLM call 2: 调 get_weather      → ~8s
  LLM call 3: 调 get_current_time  → ~8s
  LLM call 4: Supervisor 综合回复   → ~8s  ← 额外开销
  总计: 4 次 LLM 调用, ~31s
```

Multi-Agent 比单 Agent **多 1-2 次 LLM 调用**（路由 + 综合），延迟增加 25-50%。这是编排层的固有代价。

#### 生产环境降延迟手段

| 手段 | 效果 | 适用场景 |
|------|------|---------|
| **流式端点** `/multi/chat/stream` | 感知延迟从 31s 降至首 token ~8s | 所有场景 |
| **分层模型** — Supervisor 用小快模型路由 | 路由调用从 ~8s 降至 ~2s | API 支持多模型 |
| **任务复杂度路由** — 简单任务走单 Agent | 跳过 Supervisor 开销 | 可预判任务复杂度 |
| **支持并行 tool calling 的模型** | 多工具调用合并为 1 次 LLM 调用 | 模型能力支持 |

#### 关键结论

Multi-Agent 的价值不在于降低延迟，而在于**能力隔离和职责分离**。它适用于：
- 任务跨多个专业领域（研究 + 计算 + 写作），单 Agent 的 prompt 和工具集无法覆盖
- 不同 Agent 需要不同的安全策略（高危工具隔离到独立 Agent）
- 团队并行开发不同 Agent，互不影响

对于简单的单域任务（如只查天气），单 Agent 是更优选择。**架构选型应基于任务复杂度，而非默认使用最复杂的方案**。

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

### ✅ 推荐做法

- **子 Agent 职责单一**：每个 Agent 只做一类任务，工具集精简（3-5 个），prompt 简洁
- **Supervisor 提示词包含 Agent 描述**：让 LLM 了解每个 Agent 的能力边界
- **生产环境分层模型**：Supervisor 用快速/便宜模型做路由，Sub-Agent 用更强模型做执行
- **使用 outputMode: 'last_message'**：高吞吐场景减少消息膨胀
- **设置递归限制**：通过 `recursionLimit` 防止 Agent 间无限循环

### ❌ 避免做法

- **避免子 Agent 过多**：超过 5-7 个会让 Supervisor 路由困难
- **避免子 Agent 之间直接通信**：应通过 Supervisor 中转
- **避免在子 Agent 中嵌套 Supervisor**：超 2 层嵌套调试困难、延迟爆炸
- **不要忽略成本控制**：多 Agent LLM 调用次数是单 Agent 的 3-10 倍

## 5. 行动导向 (Action Guide)

### Step 1: 安装依赖

**这一步在干什么**: 引入官方 Supervisor 预构建库。

```bash
npm install @langchain/langgraph-supervisor
```

### Step 2: 定义子 Agent

**这一步在干什么**: 为每个专业化 Agent 声明元数据和构建函数。Supervisor 据 Agent 描述做路由决策，据工具列表过滤可用工具。

文件：`src/ai/agents/multi/sub-agents/research-agent.builder.ts`

```typescript
import { createAgent } from 'langchain';
import type { AgentDefinition } from '../multi-agent.types';

export const RESEARCH_AGENT_DEF: AgentDefinition = {
  name: 'research_agent',
  description: 'Information research specialist — weather, time, external data.',
  toolNames: ['get_weather', 'get_current_time'],
  systemPrompt: 'You are a research specialist. Use tools to find accurate information.',
};

export function buildResearchAgent(model, tools) {
  const agent = createAgent({
    model,
    tools,
    name: RESEARCH_AGENT_DEF.name,
    systemPrompt: RESEARCH_AGENT_DEF.systemPrompt,
  });
  // createSupervisor 需要 CompiledStateGraph，通过 .graph 获取
  return agent.graph;
}
```

`code-agent.builder.ts` 同理，配备 `calculate` 工具。

### Step 3: 实现 MultiAgentService

**这一步在干什么**: 在 NestJS 服务层封装 Supervisor 编排，统一处理模型创建、工具筛选、子 Agent 构建、结果标准化。

文件：`src/ai/agents/multi/multi-agent.service.ts`

```typescript
@Injectable()
export class MultiAgentService {
  constructor(
    private readonly modelFactory: AiModelFactory,
    private readonly toolRegistry: ToolRegistry,
    private readonly reasoningNormalizer: ReasoningNormalizer,
  ) {}

  async invoke(params: MultiAgentInvokeParams): Promise<MultiAgentInvokeResult> {
    const model = this.modelFactory.createChatModel(params.provider, { model: params.model });
    const enabledAgents = this.getEnabledAgents(params.enabledAgents);

    // 为每个子 Agent 调用 createAgent，取 .graph 获取 CompiledStateGraph
    const agentGraphs = enabledAgents.map(def => {
      const tools = this.toolRegistry.getTools(def.toolNames);
      return def.name === 'code_agent'
        ? buildCodeAgent(model, tools)
        : buildResearchAgent(model, tools);
    });

    // createSupervisor 自动为每个 Agent 生成 Handoff 工具
    const workflow = createSupervisor({
      agents: agentGraphs,
      llm: model,
      prompt: buildSupervisorPrompt(enabledAgents, params.systemPrompt),
      outputMode: 'full_history',
    });

    const result = await workflow.compile().invoke({ messages });
    return this.buildResult(result, tracer, params.provider);
  }
}
```

### Step 4: 注册到 AiModule 并添加 Controller 端点

**这一步在干什么**: DI 注册 + HTTP 端点暴露。

`ai.module.ts` providers/exports 中添加 `MultiAgentService`。

`agent.controller.ts` 新增端点：

```typescript
@Post('multi/chat')
async multiAgentChat(@Body() dto: MultiAgentChatRequestDto) {
  return this.multiAgentService.invoke({ ... });
}

@Post('multi/chat/stream')
streamMultiAgentChat(@Body() dto, @Res() res) {
  const stream$ = this.multiAgentService.stream({ ... });
  this.streamAdapter.pipeStandardStream(res, stream$, { ... });
}
```

### Step 5: 测试验证

**这一步在干什么**: 通过 API 调用验证多智能体协作流程。

```bash
curl -X POST http://localhost:3000/ai/agent/multi/chat \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "siliconflow",
    "model": "Pro/MiniMaxAI/MiniMax-M2.5",
    "messages": [{"role": "user", "content": "查一下北京天气，然后算算如果每天升高2度一周后是多少度"}]
  }'
```

预期响应：

```json
{
  "content": "北京当前气温 15°C。每天升高 2°C，一周后: 15 + 2×7 = 29°C。",
  "agentCalls": { "research_agent": 1, "code_agent": 1 },
  "totalDelegations": 2,
  "trace": { "traceId": "...", "llmCallCount": 5, "totalLatencyMs": 8200 }
}
```

#### APIpost 测试接口

**这一步在干什么**: 明确多智能体测试使用的 HTTP 端点和请求头，避免把测试重点放在接口拼装上。`/multi/chat` 用于查看完整 JSON 响应，`/multi/chat/stream` 用于观察首 token 延迟和流式事件；两者请求体完全一致。

- **Method**: `POST`
- **普通接口**: `http://localhost:3000/ai/agent/multi/chat`
- **流式接口**: `http://localhost:3000/ai/agent/multi/chat/stream`
- **Headers（普通接口）**:
  - `Content-Type: application/json`
- **Headers（流式接口）**:
  - `Content-Type: application/json`
  - `Accept: text/event-stream`
- **请求体公共字段**:
  - `provider`: 模型提供商，例如 `siliconflow`
  - `model`: 必须支持 tool calling，例如 `Pro/MiniMaxAI/MiniMax-M2.5`
  - `messages`: 对话消息数组，至少一条 `user` 消息
  - `enabledAgents`: 可选，用于限制本次启用的子 Agent；可用值为 `research_agent`、`code_agent`

#### APIpost 用例 A：只测试 Research Agent

**这一步在干什么**: 通过限制 `enabledAgents` 为 `research_agent`，验证 Supervisor 是否只委派信息检索任务，不触发计算子 Agent。这适合排查天气、时间、外部信息查询链路是否正常。

```json
{
  "provider": "siliconflow",
  "model": "Pro/MiniMaxAI/MiniMax-M2.5",
  "messages": [
    {
      "role": "user",
      "content": "帮我查询北京现在的天气和当前时间"
    }
  ],
  "enabledAgents": ["research_agent"]
}
```

#### APIpost 用例 B：测试 Code Agent


```json
{
  "provider": "siliconflow",
  "model": "Pro/MiniMaxAI/MiniMax-M2.5",
  "messages": [
    {
      "role": "user",
      "content": "请计算 15 + 2 * 7 使用code工具"
    }
  ],
  "enabledAgents": ["code_agent"]
}
```

#### APIpost 用例 C：同一参数切换到流式接口

**这一步在干什么**: 验证相同的请求体在 SSE 模式下是否能逐步返回内容，适合排查首 token 延迟、前端流式消费和链路追踪是否正常。

将上面的任意一个 JSON 请求体直接发送到：

```text
POST http://localhost:3000/ai/agent/multi/chat/stream
Accept: text/event-stream
Content-Type: application/json
```


### 文件组织

```
src/ai/agents/multi/
├── index.ts                          # Barrel 导出
├── multi-agent.types.ts              # 类型定义（AgentDefinition, InvokeParams/Result）
├── multi-agent.service.ts            # NestJS 服务（createSupervisor 编排）
├── supervisor/
│   ├── index.ts
│   └── supervisor.prompts.ts         # Supervisor 和子 Agent 系统提示词
└── sub-agents/
    ├── index.ts
    ├── research-agent.builder.ts     # Research 子 Agent（createAgent + .graph）
    └── code-agent.builder.ts         # Code 子 Agent（createAgent + .graph）
```

