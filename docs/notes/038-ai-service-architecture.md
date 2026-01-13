# 038. AI 服务模块架构设计 (AI Service Architecture)

## 1. 核心问题与概念 (The "Why")

### 解决什么问题

在 NestJS 后端中集成 AI 能力，需要解决以下架构痛点：

1. **多模型厂商适配**：DeepSeek、Qwen、GLM、MiniMax、OpenAI、Claude、Gemini 各有不同的 SDK 和 API 格式
2. **流式响应**：AI 生成是逐字输出的，需要 SSE (Server-Sent Events) 实时推送给前端
3. **推理过程获取**：部分推理模型（如 DeepSeek-R1、QwQ）会输出思考过程，需要能够捕获
4. **工具调用**：AI 需要能调用后端定义的工具（如查询数据库、调用外部 API）
5. **业务解耦**：AI 能力需要能方便地集成到任意业务模块

### 核心概念与依赖

| 概念 | 说明 |
|------|------|
| **Vercel AI SDK** | 统一的 AI 模型抽象层，提供 `streamText`、`generateText`、Agent 等能力 |
| **Provider** | 模型提供商适配器，封装各厂商 SDK 的差异 |
| **SSE (Server-Sent Events)** | HTTP 长连接技术，服务端可主动向客户端推送数据 |
| **RxJS Observable** | NestJS 原生的响应式流抽象，用于处理流式数据 |
| **Tool** | 可被 AI 调用的函数，通过 JSON Schema 描述参数 |

### 技术选型决策

| 方案 | 优点 | 缺点 | 决策 |
|------|------|------|------|
| **Vercel AI SDK** | 统一抽象、原生流式、轻量 | 主要为 Next.js 设计 | ✅ 采用 |
| LangChain.js | 功能强大、Agent 完善 | 抽象过重、API 不稳定 | ❌ 放弃 |
| 自行封装各厂商 SDK | 完全控制 | 工作量大、维护成本高 | ❌ 放弃 |

国产模型接入方式：

| 模型 | 接入方式 | 包名 |
|------|---------|------|
| DeepSeek | 官方 Provider | `@ai-sdk/deepseek` |
| Qwen | 官方网关 + 社区 | `qwen-ai-provider` |
| GLM | 社区 Provider | `zhipu-ai-provider` |
| MiniMax | 社区 Provider | `vercel-minimax-ai-provider` |

## 2. 核心用法 / 方案设计 (Usage / Design)

### 模块结构

```
src/ai/
├── ai.module.ts                    # 模块定义
├── ai.controller.ts                # HTTP 控制器（含 SSE 端点）
├── ai.service.ts                   # 业务服务层
├── index.ts                        # 统一导出
│
├── constants/
│   └── ai.constants.ts             # 枚举和注入 Token
│
├── dto/
│   ├── chat-request.dto.ts         # 请求 DTO
│   └── chat-response.dto.ts        # 响应 DTO
│
├── interfaces/
│   ├── provider.interface.ts       # IAiProvider 抽象接口
│   ├── tool.interface.ts           # IAiTool 抽象接口
│   └── agent.interface.ts          # IAiAgent 抽象接口
│
├── tools/
│   └── tool.registry.ts            # 工具注册中心
│
├── providers/                      # 预留：Provider 实现
└── agents/                         # 预留：Agent 实现
```

### 场景 A: 非流式对话

```typescript
// Controller
@Post('chat')
async chat(@Body() dto: ChatRequestDto): Promise<ChatResponseDto> {
  return this.aiService.chat(dto);
}

// 请求示例
POST /ai/chat
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "messages": [{ "role": "user", "content": "你好" }]
}
```

### 场景 B: 流式对话 (SSE)

```typescript
// Controller - 核心实现
@Post('chat/stream')
streamChat(@Body() dto: ChatRequestDto, @Res() res: Response): void {
  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx 禁用缓冲

  // 获取 Observable 并订阅
  const stream$ = this.aiService.streamChat(dto);

  stream$.subscribe({
    next: (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`),
    error: (err) => {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
      res.end();
    },
    complete: () => {
      res.write('data: [DONE]\n\n');
      res.end();
    },
  });
}
```

### 场景 C: 推理对话（含思考过程）

```typescript
// 请求时启用推理模式
POST /ai/chat/reasoning
{
  "provider": "deepseek",
  "model": "deepseek-reasoner",
  "messages": [{ "role": "user", "content": "9.11和9.9哪个大？" }],
  "enableReasoning": true
}

// 响应包含思考过程
{
  "content": "9.9 > 9.11",
  "reasoning": "让我分析一下...9.9 = 9.90，9.11 = 9.11，比较小数部分..."
}
```

## 3. 深度原理与机制 (Under the Hood)

### 流式响应数据流

```
┌─────────────┐     Observable      ┌─────────────┐      SSE       ┌─────────────┐
│  AI SDK     │ ─────────────────▶  │  AiService  │ ────────────▶  │  Controller │
│  streamText │   StreamChunk       │  streamChat │   subscribe    │  res.write  │
└─────────────┘                     └─────────────┘                └─────────────┘
                                          │
                                          ▼
                              ┌─────────────────────┐
                              │  data: {"type":     │
                              │    "text",          │
                              │    "content":"你好"}│
                              │  \n\n               │
                              └─────────────────────┘
```

### StreamChunk 类型定义

```typescript
enum StreamChunkType {
  REASONING = 'reasoning',   // 推理/思考过程
  TEXT = 'text',             // 正式文本内容
  TOOL_CALL = 'tool_call',   // 工具调用请求
  TOOL_RESULT = 'tool_result', // 工具执行结果
  DONE = 'done',             // 流结束标记
  ERROR = 'error',           // 错误信息
}

interface StreamChunk {
  type: StreamChunkType | string;
  content?: string;
  toolCall?: ToolCallInfo;
  error?: string;
}
```

### Provider 抽象接口

```typescript
interface IAiProvider {
  readonly providerId: string;
  readonly supportedModels: string[];

  generateText(options: GenerateOptions): Promise<GenerateResult>;
  streamText(options: GenerateOptions): Observable<StreamChunk>;
  isModelSupported(model: string): boolean;
}
```

遵循 DIP 原则：`AiService` 依赖 `IAiProvider` 接口，而非具体实现。

### 工具注册中心

```typescript
@Injectable()
export class ToolRegistry {
  private readonly tools = new Map<string, IAiTool>();

  register(tool: IAiTool): void { ... }
  getDefinitions(names?: string[]): ToolDefinition[] { ... }
  execute(name: string, args: Record<string, unknown>): Promise<unknown> { ... }
}
```

业务模块可以注册自己的工具，AI 在对话中自动识别并调用。

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

### ✅ 推荐做法

1. **POST 请求 + SSE 响应**：AI 对话需要传递 `messages[]` 数组（可能很大），必须用 POST。NestJS 的 `@Sse()` 装饰器只支持 GET，所以需要手动操作 `Response` 对象。

2. **使用 RxJS Observable**：比直接操作 `ReadableStream` 更符合 NestJS 生态，便于组合、转换、错误处理。

3. **配置集中管理**：API Key 统一放在 `ai.config.ts`，通过 `ConfigService` 注入，不要在代码中硬编码。

4. **接口抽象先行**：先定义 `IAiProvider`、`IAiTool` 接口，再实现具体 Provider。这样切换模型厂商时核心代码无需改动。

### ❌ 避免做法

1. **不要在多轮对话中传递 `reasoning_content`**：DeepSeek 官方文档明确指出，将推理过程放入历史消息会导致 API 返回 400 错误。

2. **不要让 SDK 内部类型穿透到前端**：使用 `StreamChunkType` 枚举做一层映射，隔离 SDK 变化对前端的影响。

3. **不要在 ToolRegistry 中引入业务依赖**：保持工具注册中心纯净，避免循环依赖。

## 5. 行动导向 (Action Guide)

### Step 1: 创建模块目录结构

**这一步在干什么**: 按照 NestJS 模块化规范，创建 AI 服务的目录骨架。

```bash
# 创建目录
mkdir -p src/ai/{dto,interfaces,constants,tools,providers,agents}
```

### Step 2: 定义核心接口

**这一步在干什么**: 遵循 DIP 原则，先定义抽象接口，为后续 Provider 实现提供契约。

关键文件：
- `src/ai/interfaces/provider.interface.ts` - 定义 `IAiProvider`、`StreamChunk`、`GenerateOptions` 等
- `src/ai/interfaces/tool.interface.ts` - 定义 `IAiTool`、`ToolDefinition`
- `src/ai/constants/ai.constants.ts` - 定义 `AiProvider` 枚举、`StreamChunkType` 枚举

### Step 3: 创建 DTO

**这一步在干什么**: 定义请求/响应的数据结构，集成 `class-validator` 校验和 Swagger 文档。

关键文件：
- `src/ai/dto/chat-request.dto.ts` - 包含 `provider`、`model`、`messages[]`、`enableReasoning` 等字段
- `src/ai/dto/chat-response.dto.ts` - 包含 `content`、`reasoning`、`usage` 等字段

### Step 4: 实现 AiService

**这一步在干什么**: 业务编排层，处理对话、流式输出、工具调用等场景。

核心方法：
- `chat()` - 非流式对话
- `streamChat()` - 返回 `Observable<StreamChunk>`
- `reasoningChat()` - 推理对话
- `chatWithTools()` - 带工具调用的对话

### Step 5: 实现 AiController

**这一步在干什么**: 暴露 HTTP 端点，处理 SSE 响应头和流式输出。

核心端点：
- `POST /ai/chat` - 非流式（Swagger 可调试）
- `POST /ai/chat/stream` - 流式 SSE
- `POST /ai/chat/reasoning` - 推理对话

### Step 6: 创建配置文件

**这一步在干什么**: 集中管理各厂商的 API Key 和 Base URL。

创建 `src/common/configs/config/ai.config.ts`，并在 `configurations` 数组中注册。

### Step 7: 注册模块

**这一步在干什么**: 将 AI 模块注册到应用中。

在 `src/app.module.ts` 的 `imports` 中添加 `AiModule`。

### Step 8: 测试验证

**非流式测试 (Swagger)**:
```json
POST /ai/chat
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "messages": [{ "role": "user", "content": "你好" }]
}
```

**流式测试 (cURL)**:
```bash
curl -N -X POST http://localhost:3000/ai/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"provider":"deepseek","model":"deepseek-chat","messages":[{"role":"user","content":"你好"}]}'
```

---

## 下一步

当前实现为 Mock 版本，已验证链路畅通。下一步需要：

1. 安装 AI SDK 依赖：`npm install ai @ai-sdk/deepseek @ai-sdk/openai ...`
2. 实现真实的 Provider（如 `DeepSeekProvider`）
3. 替换 `AiService` 中的 Mock 逻辑为真实 AI 调用
