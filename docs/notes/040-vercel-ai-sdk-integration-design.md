# 040. 前端流适配方案设计 (Vercel AI SDK Integration Design)

## 1. 核心问题与概念 (The "Why")

### 解决什么问题

当前 AI 模块（038 文档）的后端流式架构已完备：`AiService` 通过 RxJS `Subject` 产出 `Observable<StreamChunk>`，`AiController` 将其桥接为 SSE 输出。但前端消费侧存在一个协议适配问题：

| 维度 | 当前后端 SSE 格式 | Vercel AI SDK 期望格式 |
| :--- | :--- | :--- |
| 文本块 | `data: {"type":"text","content":"你好"}\n\n` | `0:"你好"\n` |
| 推理块 | `data: {"type":"reasoning","content":"思考中..."}\n\n` | `g:{"text":"思考中..."}\n` |
| 结束标记 | `data: [DONE]\n\n` | `d:{"finishReason":"stop"}\n` |
| 元信息 | 无 | `e:{"finishReason":"stop","usage":{...}}\n` |

Vercel AI SDK 的 `useChat` Hook 无法直接解析当前的原始 SSE 格式，需要一层协议转换。

### 核心概念与依赖

| 概念 | 角色 | 说明 |
| :--- | :--- | :--- |
| **Vercel AI SDK (`ai` npm 包)** | 前端 + 服务端工具库 | 提供 `useChat` (前端 React Hook) 和 `createDataStream` / `LangChainAdapter` (服务端格式转换工具) |
| **Data Stream Protocol** | 传输协议 | Vercel 定义的流式文本协议，用前缀字符标识数据类型（`0` = text, `g` = reasoning, `e` = metadata, `d` = done） |
| **`useChat` Hook** | 前端消费入口 | 自动管理消息状态、流式渲染、错误处理，期望后端返回 Data Stream Protocol 格式 |
| **`createDataStream`** | 服务端工具函数 | 在后端将自定义数据（如 `StreamChunk`）转换为 Data Stream Protocol 格式输出 |
| **`LangChainAdapter`** | 服务端适配器 | 直接将 LangChain 的 `stream()` 输出转换为 Data Stream Protocol 响应 |

### 架构决策

| 方案 | 决策 | 理由 |
| :--- | :--- | :--- |
| **方案 A: 后端 Controller 层适配（`ai` 包服务端工具）** | ✅ 采用 | 遵循 OCP，Service 层零改动；协议格式由 Vercel 团队维护，降低自研维护成本 |
| **方案 B: 前端自行解析原始 SSE** | ❌ 弃用 | 放弃了 `useChat` 的自动状态管理能力，前端需大量自定义解析代码 |
| **方案 C: 后端手写 Data Stream Protocol 格式** | ❌ 弃用 | 需要自行追踪 Vercel 协议规范变更，维护成本高且容易出错 |

---

## 2. 方案设计 (Design)

### 核心架构：Controller 层双端点并存

```
                              ┌─ /ai/chat/stream          (原始 SSE)  → curl 调试 / 自研前端
AiService                     │
  Observable<StreamChunk> ────┤
                              └─ /ai/chat/stream/ai-sdk   (Data Stream Protocol) → useChat()
```

**设计要点**：

- `AiService` 产出的 `Observable<StreamChunk>` 是**协议无关**的业务数据流，不包含任何传输格式细节
- 协议适配是"传输层关注点"，属于 Controller 层的职责
- 两种端点并存：原始 SSE 端点用于 `curl` 调试和非 React 前端，Data Stream Protocol 端点服务 Vercel AI SDK 前端

### 场景 A: 前端使用 `useChat` 消费流式对话

```typescript
// 前端代码 (React)
import { useChat } from 'ai/react';

const { messages, input, handleSubmit, isLoading } = useChat({
  api: '/ai/chat/stream/ai-sdk',
  body: {
    provider: 'deepseek',
    model: 'deepseek-chat',
  },
});
```

### 场景 B: 前端消费含推理过程的流式对话

```typescript
import { useChat } from 'ai/react';

const { messages, input, handleSubmit } = useChat({
  api: '/ai/chat/stream/ai-sdk',
  body: {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
  },
  // Vercel AI SDK 原生支持 reasoning 渲染
  // messages 中的 parts 会自动区分 text 和 reasoning
});

// 渲染时区分推理和文本
{messages.map((msg) =>
  msg.parts?.map((part, i) => {
    if (part.type === 'reasoning') {
      return <CollapsibleReasoning key={i} content={part.reasoning} />;
    }
    if (part.type === 'text') {
      return <MarkdownRenderer key={i} content={part.text} />;
    }
  })
)}
```

### 场景 C: 后端 Controller 适配端点实现

```typescript
// src/ai/ai.controller.ts — 新增端点

import { createDataStream } from 'ai';

@Post('chat/stream/ai-sdk')
@HttpCode(HttpStatus.OK)
@ApiOperation({
  summary: '流式对话（Vercel AI SDK 协议）',
  description: '输出 Data Stream Protocol 格式，供前端 useChat Hook 消费',
})
streamForVercelAiSdk(
  @Body() dto: ChatRequestDto,
  @Res() res: Response,
): void {
  const stream$ = this.aiService.streamReasoningChat(dto);

  const dataStream = createDataStream({
    execute: async (writer) => {
      await new Promise<void>((resolve, reject) => {
        const subscription = stream$.subscribe({
          next: (chunk: StreamChunk) => {
            switch (chunk.type) {
              case StreamChunkType.TEXT:
                writer.writeText(chunk.content ?? '');
                break;
              case StreamChunkType.REASONING:
                writer.writeReasoning({ text: chunk.content ?? '' });
                break;
              case StreamChunkType.TOOL_CALL:
                // 预留：工具调用适配
                break;
              case StreamChunkType.DONE:
                break;
              case StreamChunkType.ERROR:
                writer.writeError(chunk.error ?? 'Unknown error');
                break;
            }
          },
          error: reject,
          complete: resolve,
        });

        // 客户端断连时取消 Service 层的订阅
        res.on('close', () => subscription.unsubscribe());
      });
    },
  });

  // Data Stream Protocol 的标准响应头和管道输出
  const response = dataStream.toDataStreamResponse();
  res.setHeader('Content-Type', response.headers.get('Content-Type') ?? 'text/plain');
  res.setHeader('X-Accel-Buffering', 'no');
  response.body?.pipeTo(
    new WritableStream({
      write(chunk) { res.write(chunk); },
      close() { res.end(); },
    }),
  );
}
```

---

## 3. 深度原理与机制 (Under the Hood)

### Data Stream Protocol 格式解析

Vercel AI SDK 定义的流式协议使用**前缀字符**标识每行数据的语义类型：

| 前缀 | 类型 | 说明 | 示例 |
| :--- | :--- | :--- | :--- |
| `0` | Text | 文本增量 | `0:"你好"` |
| `g` | Reasoning | 推理/思考过程 | `g:{"text":"分析问题..."}` |
| `2` | Tool Call | 工具调用 | `2:{"toolCallId":"x","toolName":"search","args":{}}` |
| `a` | Tool Result | 工具返回值 | `a:{"toolCallId":"x","result":"..."}` |
| `e` | Finish Metadata | Token 用量等元信息 | `e:{"finishReason":"stop","usage":{"promptTokens":10}}` |
| `d` | Done | 流结束标记 | `d:{"finishReason":"stop"}` |
| `3` | Error | 错误信息 | `3:"rate limit exceeded"` |

### 数据流转换链路

```
LangChain model.stream()
  → AsyncIterable<AIMessageChunk>
    → ReasoningNormalizer.normalize()
      → Subject<StreamChunk>                ← 业务层边界
        → Observable<StreamChunk>
          ┌─ setupSseStream()    → 原始 SSE 格式输出
          └─ createDataStream()  → Data Stream Protocol 格式输出
                                     ↓
                                 useChat() 前端 Hook 自动解析
```

`AiService` 到 `Observable<StreamChunk>` 这条链路是两种输出格式共享的，体现了 **OCP（开闭原则）** — 新增输出格式不修改已有代码，只扩展新端点。

### 为什么选择在 Controller 层适配

| 原则 | 分析 |
| :--- | :--- |
| **SRP（单一职责）** | `AiService` 负责业务编排（模型调度、推理归一化），Controller 负责传输协议适配。协议格式是"如何传递"的问题，不是"传递什么"的问题 |
| **OCP（开闭原则）** | 新增 Data Stream Protocol 端点不修改 `AiService` 和现有 SSE 端点的任何代码 |
| **DIP（依赖倒置）** | Controller 依赖 `Observable<StreamChunk>` 这个抽象，不依赖具体的输出格式 |
| **维护成本** | 使用 `ai` 包提供的 `createDataStream()` 工具函数，协议格式的正确性由 Vercel 团队维护，而非自研 |

---

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

### ✅ 推荐做法

1. **`ai` 包同时安装在前端和后端** — 它不是纯前端库，服务端的 `createDataStream` / `LangChainAdapter` 同样由该包提供
2. **保留原始 SSE 端点** — 用于 `curl` 调试、Swagger 测试、非 React 前端对接，不要因为新增了 Data Stream Protocol 端点就删除旧端点
3. **客户端断连清理** — 在 Data Stream Protocol 端点中同样需要监听 `res.on('close')` 取消 Service 层的 Observable 订阅
4. **推理内容的前端渲染** — Vercel AI SDK 最新版的 `useChat` 返回的 `messages` 对象中，每条消息的 `parts` 数组会自动区分 `text` 和 `reasoning` 类型，前端按类型渲染即可

### ❌ 避免做法

1. **不要在 Service 层引入 `ai` 包的格式转换** — 这会将传输协议细节泄漏到业务层，违反 SRP
2. **不要手动拼接 Data Stream Protocol 字符串** — 格式细节（如转义规则、前缀定义）可能随版本变更，应使用 `createDataStream` 工具函数
3. **不要放弃 `ReasoningNormalizer`** — 即使 Vercel AI SDK 有推理支持，归一化层仍然负责屏蔽厂商差异，是不可替代的中间环节

---

## 5. 行动导向 (Action Guide)

### Step 1: 安装 `ai` 依赖

**这一步在干什么**: 在后端项目中安装 Vercel AI SDK 核心包。该包同时提供服务端工具函数（`createDataStream`、`LangChainAdapter`）和前端 Hook（`useChat`），此处仅使用服务端部分。

```bash
npm install ai
```

### Step 2: 在 Controller 中新增 Data Stream Protocol 端点

**这一步在干什么**: 在 `AiController` 中新增一个端点，将 `AiService` 产出的 `Observable<StreamChunk>` 通过 `createDataStream` 转换为 Vercel AI SDK 期望的 Data Stream Protocol 格式。现有的 SSE 端点保持不变。

```typescript
// src/ai/ai.controller.ts — 新增以下导入和端点

import { createDataStream } from 'ai';

// 在 AiController 类中新增：

@Post('chat/stream/ai-sdk')
@HttpCode(HttpStatus.OK)
@ApiOperation({
  summary: '流式对话（Vercel AI SDK 协议）',
  description: '输出 Data Stream Protocol 格式，供前端 useChat Hook 消费',
})
streamForVercelAiSdk(
  @Body() dto: ChatRequestDto,
  @Res() res: Response,
): void {
  const stream$ = this.aiService.streamReasoningChat(dto);

  const dataStream = createDataStream({
    execute: async (writer) => {
      await new Promise<void>((resolve, reject) => {
        const subscription = stream$.subscribe({
          next: (chunk: StreamChunk) => {
            switch (chunk.type) {
              case StreamChunkType.TEXT:
                writer.writeText(chunk.content ?? '');
                break;
              case StreamChunkType.REASONING:
                writer.writeReasoning({ text: chunk.content ?? '' });
                break;
              case StreamChunkType.ERROR:
                writer.writeError(chunk.error ?? 'Unknown error');
                break;
            }
          },
          error: reject,
          complete: resolve,
        });

        res.on('close', () => subscription.unsubscribe());
      });
    },
  });

  const response = dataStream.toDataStreamResponse();
  res.setHeader('Content-Type', response.headers.get('Content-Type') ?? 'text/plain');
  res.setHeader('X-Accel-Buffering', 'no');
  response.body?.pipeTo(
    new WritableStream({
      write(chunk) { res.write(chunk); },
      close() { res.end(); },
    }),
  );
}
```

### Step 3: 前端集成 `useChat`

**这一步在干什么**: 在前端 React 项目中使用 Vercel AI SDK 的 `useChat` Hook，指向 Step 2 创建的 Data Stream Protocol 端点。`useChat` 会自动解析流、管理消息状态、处理加载/错误状态。

```bash
npm install ai @ai-sdk/react
```

```typescript
// 前端 React 组件
import { useChat } from '@ai-sdk/react';

export function ChatPage() {
  const { messages, input, handleInputChange, handleSubmit, isLoading } = useChat({
    api: 'http://localhost:3000/ai/chat/stream/ai-sdk',
    body: {
      provider: 'deepseek',
      model: 'deepseek-chat',
    },
  });

  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id}>
          <strong>{msg.role}:</strong>
          {msg.parts?.map((part, i) => {
            if (part.type === 'reasoning') {
              return <details key={i}><summary>思考过程</summary>{part.reasoning}</details>;
            }
            if (part.type === 'text') {
              return <span key={i}>{part.text}</span>;
            }
          })}
        </div>
      ))}

      <form onSubmit={handleSubmit}>
        <input value={input} onChange={handleInputChange} placeholder="输入消息..." />
        <button type="submit" disabled={isLoading}>发送</button>
      </form>
    </div>
  );
}
```

### Step 4: 验证端到端流式对话

**这一步在干什么**: 使用 `curl` 测试 Data Stream Protocol 端点的输出格式，确认前缀字符和数据结构符合预期。

```bash
curl -N -X POST http://localhost:3000/ai/chat/stream/ai-sdk \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "deepseek",
    "model": "deepseek-reasoner",
    "messages": [{"role": "user", "content": "9.9和9.11哪个大？"}]
  }'
```

**预期输出格式**：

```
g:{"text":"分析这两个数字..."}
g:{"text":"9.9 = 9.90，9.11 = 9.11..."}
0:"9.9"
0:" 更大"
0:"。"
e:{"finishReason":"stop","usage":{"promptTokens":10,"completionTokens":5}}
d:{"finishReason":"stop"}
```

---

> **前置依赖**：本文档的实施依赖 038 文档中 LangChain 的真实接入（替换 mock 为真实模型调用）。建议在 LangChain 接入完成后再实施本文档的 Action Guide。
