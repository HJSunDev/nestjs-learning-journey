# 051. 高级 Agent 模式 (Advanced Agent Patterns)

## 1. 核心问题与概念 (The "Why")

### 解决什么问题

048 章的 ReAct Agent 是一个通用的"思考 → 行动 → 观察"循环，能应对多数场景。但生产环境中，不同任务特性需要不同的编排策略：

- **质量敏感型任务**：代码生成、内容创作需要"自我审查"机制——生成后自动评估，不合格则修正
- **复杂多步任务**：先规划再执行比"走一步看一步"更可靠、更可控
- **大型系统模块化**：将复杂 Agent 拆分为可复用的子图（Subgraph），独立开发、测试、组合

### 核心概念

**三种高级模式**：

| 模式 | 核心思想 | 拓扑结构 | 适用场景 |
|------|---------|---------|---------|
| **Reflection** | 生成后自我评估，不满意则修正 | `generate → evaluate → [loop \| END]` | 质量门控的内容生成 |
| **Plan-Execute** | 先规划步骤列表，再逐步执行 | `planner → executor → replanner → [loop \| END]` | 可预先分解的复杂多步任务 |
| **Subgraph** | 将子流程封装为独立图，作为节点嵌入父图 | 父图节点内 `invoke` 子图 | 模块化复用、团队协作开发 |

**与 ReAct 的关系**：
- ReAct（048）= 通用推理循环，适合"下一步依赖上一步结果"的动态场景
- Reflection = 在 ReAct 之上叠加"质量反馈环"
- Plan-Execute = 将 ReAct 的即兴决策替换为"预谋 + 执行"
- 三者可组合：Plan-Execute 的每个步骤内部可以用 ReAct Agent（子图）执行

## 2. 核心用法 / 方案设计 (Usage / Design)

### 场景 A: Reflection 自我修正

**生产用例**：代码生成后自动 review、技术文档写作后自动评审、数据提取后自动验证。

**拓扑**：

```
START → generate → evaluate → shouldReflect
                                 ├── passed=true      → END
                                 ├── count >= max      → END（强制结束，防无限循环）
                                 └── passed=false      → generate（携带评估反馈）
```

**关键设计决策**：

1. **Generator/Evaluator 解耦**：两个角色使用独立的系统提示词，可用不同模型（Evaluator 用更强模型把关）
2. **结构化评估结果**：Evaluator 返回 `{ passed, score, feedback }` JSON，而非自由文本，保证路由决策可靠
3. **反馈注入方式**：评估反馈作为 HumanMessage 追加到 messages，供 Generator 在下一轮自然参考
4. **最大反思次数**：硬上限防止无限循环，超过后返回最后一版内容（降级策略）

### 场景 B: Plan-and-Execute 规划执行

**生产用例**：复杂研究任务（多步信息收集 + 分析）、数据处理流水线、自动化工作流。

**拓扑**：

```
START → planner → executor → replanner → shouldContinueExecution
                     ↑                         │
                     └── 还有步骤 ──────────────┘
                                               │
                     finalResponse ─────────→ END
```

**关键设计决策**：

1. **Planner 结构化输出**：强制返回 `{ steps: string[] }` JSON 格式
2. **Executor 子图组合**：每个步骤通过 tool-graph 子图执行，Executor 节点负责父子状态转换
3. **Replanner 三种决策**：`complete`（任务完成）、`continue`（继续当前计划）、`replan`（调整剩余步骤）
4. **动态重规划**：当中间结果改变了后续需求时，Replanner 可重写剩余步骤

### 场景 C: Subgraph 模块化组合

**两种组合方式**（LangGraph 官方支持）：

| 模式 | 适用条件 | 实现方式 |
|------|---------|---------|
| **在节点内调用子图** | 父子图 State Schema 不同 | 节点函数内 `await subgraph.invoke(transformedInput)` |
| **直接作为节点添加** | 父子图共享 State 键 | `graph.addNode('sub', compiledSubgraph)` |

本项目的 Plan-Execute 使用**第一种**——因为 PlanExecuteState 和 AgentState 结构完全不同。

**父子状态转换**：

```typescript
// executor 节点内：
// 父 → 子：构建执行提示注入子图
const subgraphInput = {
  messages: [new SystemMessage(executorPrompt), new HumanMessage(currentStep)],
};
const subgraphResult = await toolGraphSubgraph.invoke(subgraphInput, { context });

// 子 → 父：提取子图结果
const stepResult = subgraphResult.messages[subgraphResult.messages.length - 1].content;
```

**Subgraph 持久化模式**：

| 模式 | `checkpointer=` | 行为 |
|------|-----------------|------|
| Per-invocation（默认） | 未设置 | 每次调用独立，继承父图 checkpointer 支持 interrupt |
| Per-thread | `true` | 子图状态跨调用累积（如研究助手需要记住上下文） |
| Stateless | `false` | 无 checkpoint，不支持 interrupt/durable |

## 3. 深度原理与机制 (Under the Hood)

### Reflection 的评估循环机制

```
┌─────────────────────────────────────────────────────────────┐
│                    Reflection State                         │
│  messages: [User, AI(v1), Feedback(v1), AI(v2), ...]        │
│  reflectionCount: 2                                         │
│  evaluationPassed: true                                     │
│  lastScore: 8                                               │
└─────────────────────────────────────────────────────────────┘

Round 1:
  generate → AI 生成 v1
  evaluate → Evaluator 打分 5/10，反馈 "缺少代码示例"
  shouldReflect → passed=false, count < max → 路由回 generate

Round 2:
  generate → AI 收到反馈，生成 v2（含代码示例）
  evaluate → Evaluator 打分 8/10，反馈 "质量达标"
  shouldReflect → passed=true → 路由到 END
```

**Evaluator JSON 解析容错**：
LLM 返回的 JSON 可能被 markdown 围栏包裹、格式不规范。`parseEvaluationResult` 做三层容错：
1. 去除 ```` ```json ``` ```` 围栏
2. 正则提取 `{...}` 子串
3. 字段缺失时使用安全默认值（`passed: false`）

### Plan-Execute 的 Subgraph 调用时序

```
PlanExecuteGraph
  │
  ├─ planner 节点
  │    └─ 调用 plannerModel → 返回 {"steps": ["A", "B", "C"]}
  │
  ├─ executor 节点（step A）
  │    ├─ 编译 tool-graph 子图（独立的 AgentState）
  │    ├─ 构建执行提示（当前步骤 + 上下文）
  │    ├─ subgraph.invoke()：
  │    │    ├─ callModel → shouldContinue → executeTools → callModel → END
  │    │    └─ 子图返回：{ messages: [..., AIMessage("结果A")] }
  │    └─ 提取子图最后一条 AIMessage → pastStepResults.push({step: "A", result: "结果A"})
  │
  ├─ replanner 节点
  │    └─ 审视已完成步骤 → 决策 "continue"
  │
  ├─ executor 节点（step B）
  │    └─ ... 同上流程 ...
  │
  ├─ replanner 节点
  │    └─ 决策 "complete" → 生成 finalResponse
  │
  └─ END
```

### `Command({ graph: Command.PARENT })` 跨图路由

> **什么是 Handoff（交接）？**
>
> Handoff 是多智能体系统中的一种协作模式，指一个 Agent 在完成自己负责的部分后，将控制权（连同上下文信息）**主动移交**给另一个 Agent 继续处理。类似于接力赛中的"交接棒"：
>
> ```
> 用户请求 → AgentA（擅长分析）→ Handoff → AgentB（擅长执行）→ 最终结果
> ```
>
> 例如：客服系统中，一个"意图识别 Agent"判断用户想退款后，将对话 **Handoff** 给专门的"退款处理 Agent"；或者一个"研究 Agent"收集完资料后，Handoff 给"写作 Agent"来撰写报告。Handoff 的关键在于：
> - **主动让出控制权**：当前 Agent 自己决定何时、交给谁
> - **携带上下文**：交接时传递必要的状态信息，接手方无需从零开始
> - **跨图路由**：在 LangGraph 中，Handoff 通常通过 `Command.PARENT` 实现——子图中的 Agent 直接指定父图中的下一个节点（即另一个 Agent）

当子图需要直接影响父图的路由时（如多智能体 Handoff 场景），可用 `Command.PARENT`：

```typescript
// 子图节点内
return new Command({
  update: { result: "done" },
  goto: "otherAgent",        // 父图中的节点名
  graph: Command.PARENT,      // 指示路由到父图
});
```

本项目的 Plan-Execute 不需要此机制——因为子图结果通过 executor 节点的返回值传递回父图，路由由父图的 `shouldContinueExecution` 控制。此机制在 053 多智能体协作中更常用。

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

### ✅ 推荐做法

1. **Evaluator 使用低温度**（`temperature: 0`）：评估判断需要确定性，避免随机性导致通过/不通过的波动
2. **Evaluator 可用更强模型**：Generator 用成本低的模型，Evaluator 用更强模型把关——质量与成本的平衡
3. **Plan-Execute 设置步骤上限**：防止 Planner 产出过多步骤导致 token 消耗失控
4. **Subgraph 默认用 Per-invocation**：每次调用独立，避免状态泄漏，同时继承父图的 interrupt 能力
5. **JSON 解析必须容错**：LLM 返回的 JSON 格式不可靠，必须做围栏去除、子串提取、字段默认值

### ❌ 避免做法

1. **避免 Reflection 无限循环**：必须设置 `maxReflections` 硬上限，否则 Evaluator 永远不满意时系统会卡死
2. **避免在 Evaluator 中使用 tool calling**：评估应是纯推理判断，引入工具调用增加复杂度和延迟
3. **避免 Plan-Execute 处理简单任务**：一个问题能直接回答的，不需要规划 — 过度编排反而增加延迟和成本
4. **避免子图状态与父图混淆**：明确父子图的 State Schema 边界，转换逻辑集中在调用点

### 模式选型决策树

```
用户任务
  │
  ├─ 简单直接问答 → 普通 LLM 调用（无需 Agent）
  │
  ├─ 需要工具且下一步依赖上一步？ → ReAct（048）
  │
  ├─ 生成内容需要质量把关？ → Reflection（051）
  │    └─ 适用：代码生成、文档写作、数据提取验证
  │
  ├─ 可预先分解为多个独立步骤？ → Plan-Execute（051）
  │    └─ 适用：多步研究、批量数据处理、工作流自动化
  │
  └─ 需要多个专业 Agent 协作？ → Multi-Agent（053，后续章节）
```

## 5. 行动导向 (Action Guide)

### Step 1: Reflection Graph 状态定义

**这一步在干什么**：定义 Reflection 图的 State Schema，包含反思计数器和评估结果字段。

```typescript
// src/ai/agents/single/reflection-graph/reflection.state.ts

import { StateSchema, MessagesValue } from '@langchain/langgraph';
import * as z from 'zod';

export const ReflectionState = new StateSchema({
  messages: MessagesValue,
  reflectionCount: z.number().default(0),
  maxReflections: z.number().default(3),
  evaluationPassed: z.boolean().optional(),
  lastFeedback: z.string().optional(),
  lastScore: z.number().optional(),
});

export type ReflectionStateType = typeof ReflectionState;
```

### Step 2: Reflection Graph 构建器

**这一步在干什么**：定义 generate/evaluate 节点和 shouldReflect 条件路由，组装 Reflection 图。

```typescript
// src/ai/agents/single/reflection-graph/reflection-graph.builder.ts

import { StateGraph, START, END } from '@langchain/langgraph';
import * as z from 'zod';
import { ReflectionState } from './reflection.state';

const ReflectionContextSchema = z.object({
  generatorModel: z.custom<BaseChatModel>(),
  evaluatorModel: z.custom<BaseChatModel>(),
  generatorPrompt: z.string().optional(),
  evaluationCriteria: z.string().optional(),
});

export function buildReflectionGraph(options?: {
  checkpointer?: BaseCheckpointSaver;
}) {
  const graph = new StateGraph(ReflectionState, ReflectionContextSchema)
    .addNode('generate', generateNode)      // 生成/修正内容
    .addNode('evaluate', evaluateNode)      // 评估质量
    .addEdge(START, 'generate')
    .addEdge('generate', 'evaluate')
    .addConditionalEdges('evaluate', shouldReflect, {
      generate: 'generate',                // 未通过 → 带反馈修正
      [END]: END,                           // 通过或达上限 → 结束
    });

  return graph.compile({ checkpointer: options?.checkpointer });
}
```

### Step 3: Plan-Execute 状态定义

**这一步在干什么**：定义 Plan-Execute 图的 State Schema，包含计划步骤列表、步骤结果累积器。

```typescript
// src/ai/agents/single/plan-execute-graph/plan-execute.state.ts

import { StateSchema, MessagesValue, ReducedValue } from '@langchain/langgraph';
import * as z from 'zod';

const StepResultSchema = z.object({
  step: z.string(),
  result: z.string(),
});

export type StepResult = z.infer<typeof StepResultSchema>;

export const PlanExecuteState = new StateSchema({
  messages: MessagesValue,
  plan: z.array(z.string()).default([]),
  currentStepIndex: z.number().default(0),
  // ReducedValue 累积器：每次 executor 完成一步追加一条结果
  pastStepResults: new ReducedValue(
    z.array(StepResultSchema).default([]),
    {
      inputSchema: StepResultSchema,
      reducer: (current: StepResult[], update: StepResult) => [...current, update],
    },
  ),
  finalResponse: z.string().optional(),
});
```

### Step 4: Plan-Execute Graph 构建器（含 Subgraph 组合）

**这一步在干什么**：构建 Plan-Execute 图，executor 节点内部调用 tool-graph 子图。

```typescript
// src/ai/agents/single/plan-execute-graph/plan-execute-graph.builder.ts

import { buildToolGraph } from '../tool-graph';

// executor 节点 — Subgraph 组合核心
const executorNode: GraphNode<PlanExecuteStateType> = async (state, config) => {
  const ctx = config?.context as PlanExecuteGraphContext;
  const currentStep = state.plan[state.currentStepIndex];

  // 编译 tool-graph 子图（独立的 AgentState）
  const subgraph = buildToolGraph();

  // 父 → 子状态转换
  const subgraphInput = {
    messages: [
      new SystemMessage(buildExecutorPrompt(currentStep, state.pastStepResults, objective)),
      new HumanMessage(currentStep),
    ],
  };

  // 调用子图
  const subgraphResult = await subgraph.invoke(subgraphInput, {
    context: { model: ctx.executorModel, tools: ctx.tools, maxIterations: ctx.maxIterations },
  });

  // 子 → 父状态转换
  const stepResult = subgraphResult.messages[subgraphResult.messages.length - 1].content;
  return {
    pastStepResults: { step: currentStep, result: String(stepResult) },
    currentStepIndex: state.currentStepIndex + 1,
  };
};

export function buildPlanExecuteGraph(options?) {
  return new StateGraph(PlanExecuteState, PlanExecuteContextSchema)
    .addNode('planner', plannerNode)
    .addNode('executor', executorNode)
    .addNode('replanner', replannerNode)
    .addEdge(START, 'planner')
    .addEdge('planner', 'executor')
    .addEdge('executor', 'replanner')
    .addConditionalEdges('replanner', shouldContinueExecution, {
      executor: 'executor',
      [END]: END,
    })
    .compile({ checkpointer: options?.checkpointer });
}
```

### Step 5: AdvancedPatternsService NestJS 桥接层

**这一步在干什么**：创建 NestJS 服务封装两种模式，管理模型创建、上下文注入和结果提取。

```typescript
// src/ai/agents/advanced-patterns/advanced-patterns.service.ts

@Injectable()
export class AdvancedPatternsService {
  private reflectionGraph?: ReflectionGraphCompiled;
  private planExecuteGraph?: PlanExecuteGraphCompiled;

  constructor(
    private readonly modelFactory: AiModelFactory,
    private readonly toolRegistry: ToolRegistry,
    private readonly configService: ConfigService,
  ) {}

  async invokeReflection(params: ReflectionInvokeParams): Promise<ReflectionInvokeResult> {
    const generatorModel = this.modelFactory.createChatModel(params.provider, { ... });
    const evaluatorModel = params.evaluatorModel
      ? this.modelFactory.createChatModel(params.evaluatorProvider, { temperature: 0 })
      : this.modelFactory.createChatModel(params.provider, { temperature: 0 });

    const graph = this.getReflectionGraph();
    const result = await graph.invoke(
      { messages, maxReflections: params.maxReflections ?? 3 },
      { context: { generatorModel, evaluatorModel, ... }, callbacks: [tracer] },
    );
    // ... 提取结果
  }

  async invokePlanExecute(params: PlanExecuteInvokeParams): Promise<PlanExecuteInvokeResult> {
    const tools = this.toolRegistry.getTools(params.toolNames);
    const graph = this.getPlanExecuteGraph();
    const result = await graph.invoke(
      { messages },
      { context: { plannerModel, executorModel, tools, maxIterations }, callbacks: [tracer] },
    );
    // ... 提取结果
  }
}
```

### Step 6: HTTP 端点注册

**这一步在干什么**：在 AgentController 中添加 Reflection 和 Plan-Execute 端点。

```typescript
// src/ai/agents/agent.controller.ts

// 051 端点
@Post('reflection/chat')  → advancedPatternsService.invokeReflection()
@Post('plan-execute/chat') → advancedPatternsService.invokePlanExecute()
```

### Step 7: 模块注册

**这一步在干什么**：在 AiModule 中注册 AdvancedPatternsService。

```typescript
// src/ai/ai.module.ts
providers: [..., AdvancedPatternsService],
exports: [..., AdvancedPatternsService],
```

### API 测试

```bash
# Reflection 自我修正
curl -X POST http://localhost:3000/ai/agent/reflection/chat \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "siliconflow",
    "model": "Pro/MiniMaxAI/MiniMax-M2.5",
    "messages": [{"role": "user", "content": "写一段 TypeScript 函数，实现数组去重并保持原始顺序"}],
    "evaluationCriteria": "- 代码正确性\n- 类型安全\n- 边界情况处理",
    "maxReflections": 3
  }'

# Plan-Execute 规划执行
curl -X POST http://localhost:3000/ai/agent/plan-execute/chat \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "siliconflow",
    "model": "Pro/MiniMaxAI/MiniMax-M2.5",
    "messages": [{"role": "user", "content": "帮我查询北京和上海的天气，然后告诉我哪个城市更适合出行"}],
    "tools": ["get_weather", "get_current_time"]
  }'
```

### Apipost 实测记录

#### Reflection 接口

**接口地址**：`POST /ai/agent/reflection/chat`

**这一步在验证什么**：验证 Reflection 模式是否按 `generate -> evaluate -> shouldReflect` 的闭环执行，并确认 HTTP 层返回字段与 DTO 设计一致。

**Apipost 请求参数**：

```json
{
  "provider": "siliconflow",
  "model": "Pro/MiniMaxAI/MiniMax-M2.5",
  "messages": [
    {
      "role": "user",
      "content": "写一篇关于 TypeScript 泛型的技术博客，包含示例代码，言简意赅"
    }
  ],
  "evaluationCriteria": "- 技术准确性\n- 示例可运行\n- 结构完整",
  "maxReflections": 3,
  "temperature": 0.7,
  "maxTokens": 4096
}
```

**实测响应摘要**：

```json
{
  "statusCode": 200,
  "message": "success",
  "data": {
    "content": "# TypeScript 泛型完全指南 ...",
    "reflectionCount": 1,
    "score": 9,
    "feedback": "技术内容准确，示例代码语法正确且可运行，结构清晰完整。",
    "passed": true,
    "usage": {
      "promptTokens": 106,
      "completionTokens": 1006,
      "totalTokens": 1112
    },
    "trace": {
      "traceId": "trace_xxx",
      "totalLatencyMs": 28265,
      "llmCallCount": 2,
      "totalTokens": 2679
    }
  }
}
```

**如何解读这个结果**：

1. `passed: true` 说明 Evaluator 已判定结果达标，Reflection 循环正常结束。
2. `reflectionCount: 1` 说明完成了 1 次评估轮次；当前实现中，首次生成后只要进入一次评估并通过，计数就是 `1`，不是 `0`。
3. `score: 9` 与 `feedback` 说明评估器成功返回了结构化结果，`parseEvaluationResult` 的 JSON 解析链路工作正常。
4. `trace.llmCallCount: 2` 符合 Reflection 的最小闭环预期，即 1 次 Generator 调用 + 1 次 Evaluator 调用。
5. `usage.totalTokens` 与 `trace.totalTokens` 不同是合理的：前者是最终消息提取到的 token 使用量，后者是整条链路累计的总 token。
6. 外层的 `statusCode / message / data / timestamp` 是项目统一响应包装；真正对应 `ReflectionChatResponseDto` 的是 `data` 内部字段。

**结论**：本次 Reflection 接口实测结果符合 051 章节设计预期，可直接作为 Apipost 联调基准样例。

#### Plan-Execute 接口

**接口地址**：`POST /ai/agent/plan-execute/chat`

**这一步在验证什么**：验证 Plan-Execute 模式是否完成 `planner -> executor -> replanner` 的多步执行闭环，并确认子图工具调用、步骤累积和最终汇总响应都能正常返回。

**Apipost 请求参数**：

```json
{
  "provider": "siliconflow",
  "model": "Pro/MiniMaxAI/MiniMax-M2.5",
  "messages": [
    {
      "role": "user",
      "content": "帮我查询北京和上海的天气，然后比较哪个城市更适合出行"
    }
  ],
  "tools": ["get_weather", "get_current_time"],
  "maxIterations": 5,
  "temperature": 0.7,
  "maxTokens": 4096
}
```

**实测响应摘要**：

```json
{
  "statusCode": 200,
  "message": "success",
  "data": {
    "content": "## 北京与上海天气对比分析及出行建议 ...",
    "plan": [
      "查询北京当前的天气情况，包括温度、天气状况、空气质量等",
      "查询上海当前的天气情况，包括温度、天气状况、空气质量等",
      "根据两个城市的天气数据，从温度、降水、空气质量等方面比较分析，给出哪个城市更适合出行的建议"
    ],
    "stepResults": [
      {
        "step": "查询北京当前的天气情况，包括温度、天气状况、空气质量等",
        "result": "北京当前天气：16°C，湿度 71%，雷阵雨，西北风 3 级 ..."
      },
      {
        "step": "查询上海当前的天气情况，包括温度、天气状况、空气质量等",
        "result": "上海当前天气：16°C，湿度 31%，雷阵雨，南风 3 级 ..."
      }
    ],
    "trace": {
      "traceId": "trace_xxx",
      "totalLatencyMs": 61358,
      "llmCallCount": 7,
      "totalTokens": 4994
    }
  }
}
```

**如何解读这个结果**：

1. 返回了 `plan`，说明 Planner 已成功将用户目标拆解为结构化步骤列表。
2. `stepResults` 中包含北京与上海两次查询结果，说明 Executor 内部的 `tool-graph` 子图已实际调用工具并把结果回传给父图。
3. 最终 `content` 是一段汇总分析而不是工具原始输出，说明 Replanner 在审视已完成步骤后生成了最终回答。
4. `plan` 有 3 步而 `stepResults` 只有 2 条，在当前实现下是符合预期的。因为第三步属于“综合分析并给出建议”，Replanner 可以在第二步完成后直接判定任务已具备完成条件，并通过 `finalResponse` 提前结束，而不必再进入一次独立的 Executor 步骤。
5. `trace.llmCallCount: 7` 说明本次执行不是单次模型调用，而是经历了规划、多个执行回合以及重规划/完成判断，符合 Plan-Execute 的多节点编排特征。
6. 本次响应中未返回 `usage` 也是可以接受的，因为该字段在 DTO 中本身是可选项，是否能聚合到 token 元数据取决于链路中各次消息是否携带 `usage_metadata`。
7. 外层的 `statusCode / message / data / timestamp` 依然是项目统一响应包装；真正对应 `PlanExecuteChatResponseDto` 的是 `data` 内部字段。

**结论**：本次 Plan-Execute 接口实测结果符合 051 章节设计预期，可作为复杂任务、多步工具调用场景的 Apipost 联调样例。

### 新增文件清单

```
src/ai/agents/
├── advanced-patterns/                     # 051 服务层
│   ├── index.ts
│   ├── advanced-patterns.service.ts       # NestJS 桥接服务
│   └── advanced-patterns.types.ts         # 结果类型定义
│
├── single/
│   ├── reflection-graph/                  # 051 Reflection 图
│   │   ├── index.ts
│   │   ├── reflection-graph.builder.ts    # 图构建器（generate → evaluate 循环）
│   │   ├── reflection.state.ts            # Reflection 状态定义
│   │   └── reflection.prompts.ts          # Generator/Evaluator 提示词
│   │
│   └── plan-execute-graph/                # 051 Plan-Execute 图
│       ├── index.ts
│       ├── plan-execute-graph.builder.ts  # 图构建器（含 Subgraph 组合）
│       ├── plan-execute.state.ts          # Plan-Execute 状态定义
│       └── plan-execute.prompts.ts        # Planner/Executor/Replanner 提示词

src/ai/dto/
└── advanced-patterns.dto.ts               # Reflection + Plan-Execute 请求/响应 DTO
```
