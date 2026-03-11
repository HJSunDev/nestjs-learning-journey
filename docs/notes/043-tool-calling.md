# 043. 函数调用底层机制 (Tool Calling)

## 1. 核心问题与概念 (The "Why")

### 解决什么问题

LLM 本身只能生成文本——它不知道今天几号、无法精确计算 `(3247 * 89) + 156`、也读不到任何实时数据。Tool Calling（函数调用）是让 LLM **跳出纯文本生成**、**与外部世界交互** 的核心机制。

通过 Tool Calling，模型可以：

- 查询实时信息（天气、时间、数据库、搜索引擎）
- 执行精确计算（数学运算、数据统计）
- 调用外部 API（发邮件、创建工单、操作系统）
- 操作本地资源（文件系统、数据库 CRUD）

这是从"对话型 AI"走向"智能体（Agent）"的关键一步。

### 核心概念与依赖

| 术语                              | 定义                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Tool**                    | 一个具有 name、description 和 parameters schema 的可执行函数，模型通过 function calling 协议调用它                 |
| **Tool Calling**            | 模型的一种特殊输出格式——不生成文本，而是输出"我需要调用某个工具，参数是 {...}"的结构化指令，由应用层负责实际执行 |
| **bindTools()**             | LangChain 提供的方法，将工具定义注入模型的请求参数中                                                               |
| **tool_calls**              | AIMessage 中的字段，包含模型决定调用的工具列表                                                                     |
| **ToolMessage**             | 工具执行结果的消息类型，通过 tool_call_id 关联回对应的调用                                                         |
| **Agentic Loop**            | 核心循环：invoke → 检查 tool_calls → 执行工具 → 回传结果 → 再 invoke → ... → 最终文本                        |
| **DynamicStructuredTool**   | LangChain 提供的工具类，使用 Zod Schema 定义参数，自动校验                                                         |
| **StructuredToolInterface** | LangChain 的工具接口标准，bindTools 接受此类型                                                                     |

### DynamicStructuredTool 的内部机制

`DynamicStructuredTool` 不是一个普通的函数包装器，它是 LangChain **Runnable 体系**的一部分：

```
继承链：
DynamicStructuredTool → StructuredTool → BaseLangChain → Runnable → Serializable
```

因为继承自 `Runnable`，它天然拥有 `invoke()`、`stream()`、`batch()` 等标准方法，可以无缝接入 LCEL 管道（`.pipe()`）。

调用流程（当 `ToolCallingLoop` 调用 `tool.invoke(args)` 时）：

```
tool.invoke({ city: "北京" })
  ↓
StructuredTool.invoke()
  → 检测输入是否为 ToolCall 格式，提取 args
  → 调用 this.call(args)
      ↓
StructuredTool.call()
  → 用 Zod Schema 校验参数（不合法则抛 ToolInputParsingException）
  → 校验通过后调用 this._call(parsedArgs)
      ↓
DynamicStructuredTool._call()
  → 直接调用构造时传入的 func(parsedArgs)
  → 返回字符串结果
```

**设计要点**：
- `StructuredTool` 负责参数校验（Zod parse）和 Runnable 协议适配
- `DynamicStructuredTool` 只做一件事：将 `_call()` 委托给构造时传入的 `func`
- 参数校验在 `call()` 层自动完成，`func` 收到的一定是经过 Zod 校验的合法参数
- 因为是 Runnable，`model.bindTools([tool])` 可以直接读取工具的 `name`、`description`、`schema` 来生成 JSON Schema 传给模型 API

### 与 042 结构化输出的关系

042 的 `withStructuredOutput` 和 043 的 `bindTools` 底层都使用 function calling 协议，但目的不同：

```
042 withStructuredOutput:
  目的 → 约束模型的输出格式（模型"被动"地按 Schema 生成 JSON）
  调用 → 模型调用一个"虚拟函数"来返回结构化数据
  场景 → 情感分析、实体提取等"提取型"任务

043 bindTools:
  目的 → 赋予模型调用外部工具的能力（模型"主动"决定调用哪些工具）
  调用 → 模型调用真实的可执行函数
  场景 → 需要实时数据、精确计算、外部交互的对话
```

### LLM 与外部世界交互的技术图谱

Tool Calling 并非孤立存在，它处于一个分层架构中。理解各层的定位，才能做出正确的技术选型：

```
┌─────────────────────────────────────────────────────────────┐
│  宿主应用层 (Cursor / ChatGPT / NestJS 服务)                 │
│  职责：编排 Agent 循环、管理上下文、决定调用哪些工具            │
├───────────────┬─────────────────────────────────────────────┤
│               │                                             │
│  Tool Calling │    MCP (Model Context Protocol)             │
│  (函数调用)    │    (模型上下文协议)                          │
│  ───────────  │    ─────────────────                        │
│  LLM 原生能力  │    应用协议层 (JSON-RPC 2.0)                 │
│  模型输出结构化│    工具在服务端注册、运行时发现                │
│  调用指令      │    厂商无关、有状态会话                       │
│  是所有上层方  │    底层仍依赖 Tool Calling                   │
│  案的基石      │    让模型做决策                              │
│               │                                             │
├───────────────┴─────────────────────────────────────────────┤
│  执行层                                                      │
│  数据库查询 / API 调用 / 文件操作 / 命令执行 / 浏览器控制       │
└─────────────────────────────────────────────────────────────┘
```

| 维度     | Tool Calling                                        | MCP                                                 |
| -------- | --------------------------------------------------- | --------------------------------------------------- |
| 定位     | LLM 原生能力——模型输出"我要调 X 工具"的 JSON 指令 | 应用协议——标准化工具的发现、认证、执行            |
| 工具定义 | 每次请求随 prompt 发送 JSON Schema                  | 服务端注册一次，客户端运行时发现                    |
| 复用性   | 绑定在应用代码中                                    | 一个 MCP Server 可被 Cursor、ChatGPT 等多客户端调用 |
| 安全     | 凭证在应用进程内                                    | 凭证隔离在 Server 端                                |
| 状态     | 无状态                                              | 有状态会话                                          |
| 适用场景 | 单一服务内的工具调用                                | 多客户端共享工具、跨进程工具隔离                    |

**关键认知**：Tool Calling 是地基，MCP 是建在地基之上的标准化协议。Cursor 之所以能操控你的电脑（执行终端命令、读写文件、控制浏览器），底层就是 Tool Calling 驱动的 Agentic Loop——与本章实现的 `ToolCallingLoop` 原理一致，只是 Cursor 的工具执行器拥有文件系统和终端的访问权限。

**本项目的选型**：当前阶段是单一 NestJS 服务，工具注册在进程内，Tool Calling 直接调用即可。当项目演进到需要"多客户端共享工具"或"跨进程工具隔离"时，可将 `ToolRegistry` 改造为 MCP Server，这是一个自然的演进路径。

## 2. 核心用法 / 方案设计 (Usage / Design)

### 场景 A: 定义一个工具（DynamicStructuredTool + Zod）

```typescript
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

const weatherTool = new DynamicStructuredTool({
  name: 'get_weather',
  description: '查询指定城市的当前天气信息',
  schema: z.object({
    city: z.string().describe('城市名称'),
  }),
  func: async ({ city }) => {
    // 调用天气 API 或返回模拟数据
    return `${city}当前天气：晴，25°C`;
  },
});
```

**关键点**：

- `name`：模型调用时使用的标识符，建议 snake_case
- `description`：模型据此判断何时调用此工具，务必写清楚使用场景
- `schema`：Zod Schema 定义参数结构，LangChain 转为 JSON Schema 传给模型
- `func`：实际执行逻辑，返回字符串给模型继续推理

### 场景 B: 将工具绑定到模型

```typescript
// 获取工具实例
const tools = toolRegistry.getTools(['get_weather', 'calculate']);

// 绑定到模型 — bindTools 将工具定义注入请求参数
const modelWithTools = model.bindTools(tools);

// 调用模型 — 模型可能返回 tool_calls 或直接返回文本
const response = await modelWithTools.invoke(messages);

if (response.tool_calls?.length) {
  // 模型决定调用工具
  for (const tc of response.tool_calls) {
    console.log(`调用工具: ${tc.name}(${JSON.stringify(tc.args)})`);
  }
} else {
  // 模型直接回答
  console.log(response.content);
}
```

### 场景 C: 完整的 Agentic Loop（工具调用循环）

```typescript
const modelWithTools = model.bindTools(tools);
let messages: BaseMessage[] = [new HumanMessage('北京今天天气如何？')];

for (let round = 0; round < MAX_ROUNDS; round++) {
  const response = await modelWithTools.invoke(messages);

  // 没有 tool_calls → 最终回答
  if (!response.tool_calls?.length) {
    return response.content; // "北京今天晴朗，25°C，适合出门。"
  }

  // 将模型的 AIMessage（含 tool_calls）加入对话历史
  messages.push(response);

  // 执行每个工具调用
  for (const tc of response.tool_calls) {
    const result = await toolRegistry.execute(tc.name, tc.args);

    // 将工具结果作为 ToolMessage 加入对话历史
    messages.push(new ToolMessage({
      content: result,
      tool_call_id: tc.id,
    }));
  }
  // 循环：模型看到工具结果后再次推理
}
```

## 3. 深度原理与机制 (Under the Hood)

### API 层面：Tool Calling 协议

当调用 `model.bindTools(tools)` 并 invoke 时，实际发送给 API 的请求是：

```json
{
  "model": "Pro/MiniMaxAI/MiniMax-M2.5",
  "messages": [{"role": "user", "content": "北京天气如何？"}],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "查询指定城市的当前天气信息",
        "parameters": {
          "type": "object",
          "properties": {
            "city": { "type": "string", "description": "城市名称" }
          },
          "required": ["city"]
        }
      }
    }
  ]
}
```

模型返回的不是文本，而是 tool_calls：

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"city\": \"北京\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

### Agentic Loop 数据流

```
Round 1:
  [HumanMessage("北京天气如何？")]
    → model.invoke() → AIMessage(tool_calls: [{name: "get_weather", args: {city: "北京"}}])
    → execute get_weather({city: "北京"}) → "北京当前天气：晴，25°C"
    → 追加 [AIMessage(tool_calls), ToolMessage("北京当前天气：晴，25°C")]

Round 2:
  [HumanMessage, AIMessage(tool_calls), ToolMessage]
    → model.invoke() → AIMessage(content: "北京今天天气晴朗，温度25°C，适合出行。")
    → 无 tool_calls → 返回最终文本
```

### 项目分层架构

```
┌─────────────────────────────────────────────────────────────┐
│  LcelController                                             │
│  POST /ai/lcel/tool-calling/chat                            │
│  POST /ai/lcel/tool-calling/chat/stream                     │
│  GET  /ai/lcel/tools                                        │
├─────────────────────────────────────────────────────────────┤
│  LcelService                                                │
│  toolChat() / streamToolChat()                              │
│  ├── validateToolCallingSupport()   模型能力预检             │
│  ├── modelFactory.createChatModel() 创建模型实例             │
│  └── toolCallingLoop.execute()      委托循环引擎             │
├─────────────────────────────────────────────────────────────┤
│  ToolCallingLoop                     核心 Agentic 循环引擎   │
│  ├── bindTools()                     绑定工具到模型          │
│  ├── executeToolCallRound()          单轮工具执行            │
│  ├── streamFinalResponse()           流式最终响应            │
│  └── buildResult()                   组装响应                │
├─────────────────────────────────────────────────────────────┤
│  ToolRegistry                        工具注册中心            │
│  ├── register()                      注册 StructuredTool    │
│  ├── getTools()                      获取工具实例列表        │
│  └── execute()                       执行工具（含错误兜底）   │
├─────────────────────────────────────────────────────────────┤
│  Tool Definitions                    具体工具实现            │
│  ├── get_current_time                时间查询                │
│  ├── calculate                       数学计算                │
│  └── get_weather                     天气查询（模拟）         │
└─────────────────────────────────────────────────────────────┘
```

### ToolRegistry 重构：从 IAiTool 到 LangChain 原生

038 章节预留了自定义的 `IAiTool` 接口，043 章节将其重构为直接存储 LangChain 的 `StructuredToolInterface`：

```
重构前 (038):
  IAiTool → 自定义 ToolDefinition (JSON Schema)
  需要手动适配才能与 LangChain 配合

重构后 (043):
  StructuredToolInterface → DynamicStructuredTool (Zod Schema)
  可直接传给 model.bindTools()，零适配成本
```

### 流式工具调用的设计权衡

流式模式下的 Agentic Loop 有两种策略：

| 策略                       | 中间轮次               | 最终轮次       | 优势             | 劣势                                  |
| -------------------------- | ---------------------- | -------------- | ---------------- | ------------------------------------- |
| **全流式**           | stream + concat chunks | stream         | 中间轮次也能观察 | 实现复杂，需手动合并 tool_call_chunks |
| **混合式（本项目）** | invoke（非流式）       | stream（流式） | 实现简洁、可靠   | 中间轮次无流式体验                    |

本项目选择混合策略，原因：

- 中间轮次的 tool_calls JSON 对用户无意义，流式传输无体验收益
- 工具执行时间通常远大于模型推理时间
- 通过 TOOL_CALL / TOOL_RESULT SSE 事件实时通知前端工具执行进度

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

- ✅ **工具描述要精确**：description 是模型决定是否调用工具的唯一依据。写清"何时使用"而非"做什么"
- ✅ **参数用 `.describe()` 注解**：Zod schema 每个字段都加 describe，模型据此生成正确参数
- ✅ **工具执行失败要兜底**：将错误信息作为 ToolMessage 返回给模型，让模型决定重试或换方案
- ✅ **设置 maxIterations 上限**：防止模型陷入"调工具→看结果→再调同一个工具"的死循环
- ✅ **工具返回字符串**：LangChain 的 ToolMessage content 只接受字符串，复杂对象需 JSON.stringify
- ❌ **不要在工具中使用 `eval()`**：用白名单正则 + Function 构造器替代，防止代码注入
- ❌ **不要混用 bindTools 和 withStructuredOutput**：两者都使用 function calling 协议，同时使用会冲突
- ❌ **不要忽略 tool_call_id**：ToolMessage 的 tool_call_id 必须与 AIMessage 中的 id 精确匹配，否则模型无法关联结果

## 5. 行动导向 (Action Guide)

### Step 1: 创建工具定义

**这一步在干什么**：使用 LangChain 的 `DynamicStructuredTool` 创建可被模型调用的工具。每个工具是一个工厂函数，返回 `DynamicStructuredTool` 实例。工具定义放在 `src/ai/tools/definitions/` 目录下。

```typescript
// src/ai/tools/definitions/get-current-time.tool.ts
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

export function createGetCurrentTimeTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'get_current_time',
    description:
      '获取当前的日期和时间。当用户询问时间、日期、星期几时使用此工具。',
    schema: z.object({
      timezone: z
        .string()
        .optional()
        .describe('IANA 时区标识符，如 "Asia/Shanghai"'),
    }),
    func: async ({ timezone }) => {
      const tz = timezone || 'Asia/Shanghai';
      const now = new Date();
      const formatted = now.toLocaleString('zh-CN', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        weekday: 'long',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      });
      return `当前时间（${tz}）：${formatted}`;
    },
  });
}
```

```typescript
// src/ai/tools/definitions/calculate.tool.ts
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

const SAFE_MATH_PATTERN = /^[\d\s+\-*/().%]+$/;

export function createCalculateTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'calculate',
    description:
      '计算数学表达式并返回精确结果。当用户需要精确数值计算时使用此工具。',
    schema: z.object({
      expression: z.string().describe('数学表达式，如 "(25 * 4) + 17.5"'),
    }),
    func: async ({ expression }) => {
      if (!SAFE_MATH_PATTERN.test(expression)) {
        return `计算失败：表达式包含非法字符。`;
      }
      try {
        const result = new Function(
          `"use strict"; return (${expression})`,
        )() as number;
        if (!Number.isFinite(result)) {
          return `计算结果无效（${result}）`;
        }
        return `${expression} = ${result}`;
      } catch {
        return `计算失败：无法解析表达式`;
      }
    },
  });
}
```

```typescript
// src/ai/tools/definitions/get-weather.tool.ts
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

export function createGetWeatherTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'get_weather',
    description: '查询指定城市的当前天气信息。',
    schema: z.object({
      city: z.string().describe('城市名称，如 "北京"、"上海"'),
    }),
    func: async ({ city }) => {
      // 生产环境替换为真实 API 调用
      return `${city}当前天气：晴，25°C，湿度 55%，东南风 2级。`;
    },
  });
}
```

```typescript
// src/ai/tools/definitions/index.ts
export { createGetCurrentTimeTool } from './get-current-time.tool';
export { createCalculateTool } from './calculate.tool';
export { createGetWeatherTool } from './get-weather.tool';
```

### Step 2: 重构 ToolRegistry

**这一步在干什么**：将 ToolRegistry 从自定义 `IAiTool` 接口迁移到 LangChain 原生 `StructuredToolInterface`，使注册的工具可以直接传给 `model.bindTools()`，消除适配层。在构造函数中自动注册内置工具。

```typescript
// src/ai/tools/tool.registry.ts
import { Injectable, Logger } from '@nestjs/common';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  createGetCurrentTimeTool,
  createCalculateTool,
  createGetWeatherTool,
} from './definitions';

@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, StructuredToolInterface>();

  constructor() {
    this.registerBuiltinTools();
  }

  private registerBuiltinTools(): void {
    this.register(createGetCurrentTimeTool());
    this.register(createCalculateTool());
    this.register(createGetWeatherTool());
    this.logger.log(`内置工具注册完成，共 ${this.tools.size} 个可用工具`);
  }

  register(tool: StructuredToolInterface): void {
    this.tools.set(tool.name, tool);
  }

  getTools(names?: string[]): StructuredToolInterface[] {
    const targetNames = names ?? this.getNames();
    return targetNames
      .map((name) => this.tools.get(name))
      .filter((tool): tool is StructuredToolInterface => tool !== undefined);
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`工具 "${name}" 不存在`);
    try {
      const result = await tool.invoke(args);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (error) {
      // 将错误信息返回给模型，让模型决定如何处理
      return `工具 "${name}" 执行出错: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  getNames(): string[] { return Array.from(this.tools.keys()); }
  get size(): number { return this.tools.size; }
}
```

### Step 3: 实现 ToolCallingLoop（核心 Agentic 循环）

**这一步在干什么**：构建工具调用的核心循环引擎。它接收模型和消息，通过 `bindTools` 绑定工具，在循环中检测 `tool_calls`、执行工具、回传结果，直到模型生成最终文本或达到最大迭代次数。

```typescript
// src/ai/tools/tool-calling.loop.ts (核心逻辑简化版)
@Injectable()
export class ToolCallingLoop {
  constructor(private readonly toolRegistry: ToolRegistry) {}

  async execute(params: {
    model: BaseChatModel;
    messages: Message[];
    systemPrompt?: string;
    toolNames?: string[];
    maxIterations?: number;
  }): Promise<ToolCallingResult> {
    const tools = this.toolRegistry.getTools(params.toolNames);
    const modelWithTools = model.bindTools(tools);
    const currentMessages = convertToLangChainMessages(params.messages, params.systemPrompt);
    const rounds: ToolCallRound[] = [];

    for (let i = 0; i < maxIterations; i++) {
      const response = await modelWithTools.invoke(currentMessages);

      if (!response.tool_calls?.length) {
        return this.buildResult(response, rounds);
      }

      // 执行工具并追加消息
      const round = await this.executeToolCallRound(i + 1, response, currentMessages);
      rounds.push(round);
    }

    // 达到上限，移除工具绑定做最终推理
    const finalResponse = await params.model.invoke(currentMessages);
    return this.buildResult(finalResponse, rounds);
  }
}
```

### Step 4: 添加 DTO 和 API 端点

**这一步在干什么**：创建工具调用的请求/响应 DTO，并在 LcelController 中添加 3 个端点：获取工具列表、非流式工具调用、流式工具调用。

```typescript
// DTO: src/ai/dto/tool-calling.dto.ts
export class ToolCallingChatRequestDto {
  provider: AiProvider;
  model: string;
  messages: ToolCallingMessageDto[];
  systemPrompt?: string;
  tools?: string[];       // 启用的工具名称，为空则全部启用
  temperature?: number;
  maxTokens?: number;
  maxToolRounds?: number;  // 最大工具调用轮次，默认 5
}

export class ToolCallingResponseDto {
  content: string;                    // 最终文本
  rounds: ToolCallRoundDto[];         // 工具调用历史
  totalRounds: number;                // 总轮次数
  usage?: { ... };
  finishReason?: string;
}
```

```typescript
// Controller 端点:
// GET  /ai/lcel/tools                       → 获取可用工具列表
// POST /ai/lcel/tool-calling/chat           → 非流式工具调用对话
// POST /ai/lcel/tool-calling/chat/stream    → 流式工具调用对话
```

### Step 5: 注册到 AiModule

**这一步在干什么**：将 `ToolCallingLoop` 注册为 NestJS Provider，使其可被 `LcelService` 依赖注入。

```typescript
// src/ai/ai.module.ts
import { ToolCallingLoop } from './tools/tool-calling.loop';

@Module({
  providers: [
    // ... 已有 providers
    ToolCallingLoop,  // 043 新增
  ],
  exports: [
    // ... 已有 exports
    ToolCallingLoop,  // 043 新增
  ],
})
export class AiModule {}
```

### Step 6: 验证

发送一个包含多工具组合调用的请求：

```bash
curl -X POST http://localhost:3000/ai/lcel/tool-calling/chat \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "siliconflow",
    "model": "Pro/MiniMaxAI/MiniMax-M2.5",
    "messages": [
      {"role": "user", "content": "现在几点了？北京天气怎么样？再帮我算一下 (156 * 23) + 89"}
    ],
    "systemPrompt": "你是一个智能助手，请使用工具获取信息后回答用户。",
    "maxToolRounds": 3
  }'
```

期望模型会在一轮或两轮内调用 `get_current_time`、`get_weather`、`calculate` 三个工具，然后基于工具结果生成自然语言回复。
