# 040. 前端流适配方案设计 (Vercel AI SDK Integration Design)

## 1. 核心问题与概念 (The "Why")

### 解决什么问题

当前 AI 模块（038 文档）的后端流式架构已完备：`AiService` 通过 RxJS `Subject` 产出 `Observable<StreamChunk>`，`AiController` 将其桥接为纯净的 SSE 输出。但前端消费侧存在一个协议适配问题：

| 维度 | 当前后端 SSE 格式 | Vercel AI SDK (v6) 期望格式 |
| :--- | :--- | :--- |
| **握手/生命周期** | 无特定起始标记 | `{"type":"start"}` 和 `{"type":"start-step"}` 等 |
| **文本块** | `data: {"type":"text","content":"你好"}\n\n` | `{"type":"text-delta","id":"t-1","delta":"你好"}` |
| **推理块** | `data: {"type":"reasoning","content":"思考中"}\n\n` | `{"type":"reasoning-delta","id":"r-0","delta":"思考中"}` |
| **结束标记** | `data: [DONE]\n\n` | `{"type":"finish","finishReason":"stop"}` |
| **元信息** | 无标准挂载点 | `{"type":"finish", "usage": {...}}` |

Vercel AI SDK 最新版（v6）的 `useChat` Hook 采用 **UIMessageStream** 协议，无法直接解析服务端的原始 SSE 格式，需要进行协议级别的适配转换。

### 核心概念与依赖

| 概念 | 角色 | 说明 |
| :--- | :--- | :--- |
| **Vercel AI SDK (`ai` npm 包)** | 前端工具库 | 提供 `useChat` (React Hook)，负责前端的状态管理和流式渲染。 |
| **UIMessageStream 协议** | 传输协议 | Vercel SDK v6 定义的基于 JSON-over-SSE 的通信规范，具有严格的生命周期事件 (`start`, `delta`, `end`, `finish`)。 |
| **`useChat` Hook** | 前端消费入口 | 自动管理消息状态、流式渲染、Token 元信息统计。期望后端返回 UIMessageStream 格式。 |

### 架构决策

| 方案 | 决策 | 理由 |
| :--- | :--- | :--- |
| **方案 A: 后端手写 UIMessageStream 协议（无依赖）** | ✅ 采用 | **顶级最佳实践**：遵循 OCP 和 DIP，Controller 负责格式转换，业务层零改动；**完全移除后端对 `ai` 前端包的依赖，避免版本升级带来的 Break Change；零类型抑制，极致性能。** |
| **方案 B: 后端引入 `ai` 或 `@ai-sdk/ui-utils` 进行转换** | ❌ 弃用 | 前端包服务端 API 变动剧烈（v4 `createDataStream` 在 v6 中已被完全移除），导致后端代码极易过时崩溃，且存在 Web Stream 与 Express Response 桥接的类型冲突。 |
| **方案 C: 前端自行解析原始 SSE** | ❌ 弃用 | 放弃了 `useChat` 开箱即用的自动状态管理能力，前端需编写大量重复性解析代码。 |

---

## 2. 方案设计 (Design)

### 核心架构：Controller 层双端点并存

```text
                              ┌─ /ai/chat/stream          (纯净 SSE)  → curl 调试 / 移动端 / 旧系统
AiService                     │
  Observable<StreamChunk> ────┤
                              └─ /ai/chat/stream/ai-sdk   (UIMessageStream) → Vercel useChat()
```

**设计要点**：

- `AiService` 产出的 `Observable<StreamChunk>` 是**协议无关**的业务数据流，包含统一提炼的 `content`、`reasoning` 和 `usage` 元数据。
- 协议适配是"传输层关注点"，属于 Controller 层的职责。
- 两种端点并存：普通端点应对高兼容性调用，适配端点专供 React 大前端。

### 场景 A: 前端使用 `useChat` 消费普通对话

```typescript
// 前端代码 (React)
import { useChat } from '@ai-sdk/react';

const { messages, input, handleSubmit, isLoading } = useChat({
  api: '/api/ai/chat/stream/ai-sdk',
  body: {
    provider: 'deepseek',
    model: 'deepseek-chat',
  },
});
```

### 场景 B: 前端消费含推理过程的流式对话并展示 Token 用量

```typescript
import { useChat } from '@ai-sdk/react';

const { messages, input, handleSubmit } = useChat({
  api: '/api/ai/chat/stream/ai-sdk',
  body: {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    enableReasoning: true
  },
  // 获取后端传来的 Token 统计
  onFinish: (message, { usage, finishReason }) => {
    console.log('Token consumed:', usage.totalTokens);
  }
});

// 渲染时区分推理和文本
{messages.map((msg) =>
  msg.parts?.map((part, i) => {
    if (part.type === 'reasoning') {
      return <details key={i}><summary>思考过程</summary>{part.reasoning}</details>;
    }
    if (part.type === 'text') {
      return <MarkdownRenderer key={i} content={part.text} />;
    }
  })
)}
```

---

## 3. 深度原理与机制 (Under the Hood)

### UIMessageStream 协议生命周期

我们的后端适配器严格按照以下状态机推送 JSON 数据块：

1. **握手阶段**: 发送 `{"type":"start"}` 和 `{"type":"start-step"}`，前端收到后立即创建占位消息，消除 TTFT（首字延迟）焦虑。
2. **推理阶段 (可选)**: 自动分配独立 ID (`r-0`)，依次触发 `reasoning-start` -> 多次 `reasoning-delta` -> `reasoning-end`。
3. **文本阶段**: 自动分配独立 ID (`t-1`)，依次触发 `text-start` -> 多次 `text-delta` -> `text-end`。
4. **收官与元数据**: 发送 `finish-step`，并在最后的 `finish` 事件中挂载 `finishReason` 和 `usage` (Token 用量)，最后以标准 SSE 的 `[DONE]` 彻底闭合流。

### 为什么坚决不使用 `ai` 包的服务端适配器？

这是一个经典的“框架侵入性防御”案例。
在 Vercel AI SDK 的演进中，其服务端导出 API 从 v3 的 `OpenAIStream`，到 v4/v5 的 `createDataStream`，再到 v6 完全移除重构为 `createUIMessageStream`。如果 NestJS 深度耦合这个前端库，每一次大版本升级都会导致后端代码大面积报红、类型报错。
通过查阅协议底层的 `UIMessageChunk` 接口规范，我们手动实现这套基于 JSON-over-SSE 的文本协议，使得服务端彻底摆脱了 NPM 依赖的羁绊，拥有了独立演进的健壮性。

---

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

### ✅ 推荐做法

- **保证 Part ID 的唯一性和连续性**：在后端为 reasoning 和 text 分配互不冲突的 ID（如 `r-0`, `t-1`），前端才能正确切分 `msg.parts`。
- **采集并在流尾部下发 `usage`**：流式交互的 Token 计费极为关键，确保在 LangChain 的最后一个 chunk 中提取 `usage_metadata`，并通过 `finish` 事件推送给大前端。
- **保留原始 SSE 端点**：不要因为新增了 AI SDK 适配端点就覆盖原始端点，运维脚本、Postman 调试和非前端消费者仍然需要纯净的原始 SSE。

### ❌ 避免做法

- **拒绝在后端引入 `ai` 等前端生态依赖**：避免产生不必要的版本兼容地狱。
- **避免在 Service 层处理协议**：`AiService` 只产出统一的 `StreamChunk`，永远不要在业务层拼接 `{"type":"text-delta"}` 这种专属传输协议格式。

---

## 5. 行动导向 (Action Guide) 

### Step 1: 确保 StreamChunk 接口支持元数据

**这一步在干什么**: 在业务层的契约接口中增加 `usage` 和 `finishReason`，使得底层 LangChain 的 Token 统计能够透传出来。

```typescript
// src/ai/interfaces/provider.interface.ts
export interface StreamChunk {
  type: StreamChunkType;
  content?: string;
  // ... 其他属性
  usage?: TokenUsage;
  finishReason?: string;
}
```

### Step 2: 在 AiController 中手写 UIMessageStream 适配器

**这一步在干什么**: 作为一个干净的桥接器，将 `Observable<StreamChunk>` 转换为 Vercel 协议，不引入任何第三方依赖。

> **💡 框架认知：为什么使用 `@Res() res: Response` 且返回值为 `void`？**
> - **常规接口**：通常是等整个业务逻辑处理完后，`return` 一个完整的结果，由 NestJS 自动封装成 HTTP 响应。
> - **流式接口**：因为流式数据是“持续产生”的，不能等全部处理完再返回。因此我们通过 `@Res() res: Response` 接收 NestJS 注入的底层 Express 响应对象。这相当于拿到了一根**通向客户端的管道**。方法签名是 `void` 不返回数据，而是每次产生流的一个数据块时，直接调用 `res.write(...)` 写入管道，数据就会立刻推送到客户端。

```typescript
// src/ai/ai.controller.ts
@Public()
@Post('chat/stream/ai-sdk')
@HttpCode(HttpStatus.OK)
@ApiOperation({ summary: '流式对话（Vercel AI SDK 协议）' })
@ApiProduces('text/event-stream')
streamForVercelAiSdk(@Body() dto: ChatRequestDto, @Res() res: Response): void {
  const stream$ = dto.enableReasoning 
    ? this.aiService.streamReasoningChat(dto) 
    : this.aiService.streamChat(dto);
  
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  let reasoningPartId: string | null = null;
  let textPartId: string | null = null;
  let partCounter = 0;

  const writeSseEvent = (data: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // 1. 发送初始化握手
  writeSseEvent({ type: 'start' });
  writeSseEvent({ type: 'start-step' });

  const subscription = stream$.subscribe({
    next: (chunk: StreamChunk) => {
      // 2. 推理块处理
      if (chunk.type === StreamChunkType.REASONING) {
        if (!reasoningPartId) {
          reasoningPartId = `r-${partCounter++}`;
          writeSseEvent({ type: 'reasoning-start', id: reasoningPartId });
        }
        writeSseEvent({ type: 'reasoning-delta', id: reasoningPartId, delta: chunk.content ?? '' });
      } 
      // 3. 正文块处理
      else if (chunk.type === StreamChunkType.TEXT) {
        if (reasoningPartId) {
          writeSseEvent({ type: 'reasoning-end', id: reasoningPartId });
          reasoningPartId = null; // 关闭思考部分
        }
        if (!textPartId) {
          textPartId = `t-${partCounter++}`;
          writeSseEvent({ type: 'text-start', id: textPartId });
        }
        writeSseEvent({ type: 'text-delta', id: textPartId, delta: chunk.content ?? '' });
      } 
      // 4. 结束并推送元数据
      else if (chunk.type === StreamChunkType.DONE) {
        if (reasoningPartId) writeSseEvent({ type: 'reasoning-end', id: reasoningPartId });
        if (textPartId) writeSseEvent({ type: 'text-end', id: textPartId });
        
        writeSseEvent({ type: 'finish-step' });
        writeSseEvent({
          type: 'finish',
          finishReason: chunk.finishReason ?? 'stop',
          usage: chunk.usage, // Token 使用量透传给前端
        });
      }
    },
    error: (err) => {
      writeSseEvent({ type: 'error', errorText: err.message });
      res.write('data: [DONE]\n\n');
      res.end();
    },
    complete: () => {
      res.write('data: [DONE]\n\n');
      res.end();
    },
  });

  res.on('close', () => subscription.unsubscribe());
}
```

### Step 3: API 工具验证 (ApiPost / cURL)

**这一步在干什么**: 使用工具直接调用 `POST /ai/chat/stream/ai-sdk`，观察输出流是否遵循上述定义的协议规范，确保前端可以无缝解析。

```bash
curl -N -X POST http://localhost:3000/ai/chat/stream/ai-sdk \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "deepseek",
    "model": "deepseek-reasoner",
    "messages": [{"role": "user", "content": "你好"}],
    "enableReasoning": true
  }'
```
预期获得如 `{"type":"reasoning-delta","id":"r-0","delta":"..."}` 及结尾带有 `usage` 统计的标准 JSON 输出流。