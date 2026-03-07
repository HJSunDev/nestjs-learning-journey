# 038. AI 服务模块架构设计 (AI Service Architecture)

## 1. 核心问题与概念

### 解决什么问题

在 NestJS 服务端中集成 AI 能力，需要解决以下架构痛点：

1. **多模型厂商适配**：DeepSeek、Qwen（通义千问）、Moonshot（Kimi）、GLM（智谱）等厂商的 API 标准各异，业务代码不应与具体厂商耦合。
2. **推理字段（Reasoning）差异**：支持 Chain of Thought 的模型会在响应中附带推理过程，但各厂商的字段位置和启用方式不同，需要归一化处理。
3. **流式响应标准化**：无论是简单对话流还是包含推理过程的混合流，前端都需要统一的 SSE 消费格式。
4. **架构扩展性**：从基础的单次对话，到多轮对话、工具调用，再到 LangGraph 智能体，架构需要支持渐进式演进。

### 核心概念与依赖

| 概念                          | 角色       | 说明                                                                                 |
| :---------------------------- | :--------- | :----------------------------------------------------------------------------------- |
| **LangChain Core**      | 模型抽象层 | 提供 `BaseChatModel`、`Runnable`、`Message` 等核心抽象，统一不同厂商的模型接口 |
| **AiModelFactory**      | 工厂层     | 委托协议适配器创建 LangChain Model，封装 API Key / Base URL 等细节                  |
| **ReasoningNormalizer** | 归一化层   | 从各厂商的 LangChain 输出中提取推理字段，输出统一的 `{ content, reasoning }` 结构  |
| **LangGraph**           | Agent 框架 | 构建有状态的智能体应用（Stateful, Multi-Actor Applications），详见后续章节           |
| **Vercel AI SDK**       | 前端适配   | 提供 `useChat` 等前端消费协议，后端需做流格式适配（后续章节）                      |

### 技术选型决策

| 方案                                     | 决策                | 理由                                                    |
| :--------------------------------------- | :------------------ | :------------------------------------------------------ |
| **LangChain + LangGraph**          | ✅ 内核采用         | 工业标准，模型接口统一，Agent 图编排能力强，生态丰富    |
| **@langchain/openai 包装国内模型** | ❌ 弃用             | 该包会丢弃 `reasoning_content` 字段，无法获取推理过程 |
| **Vercel AI SDK Core**             | ⚠️ 仅作前端适配层 | Agent 状态管理能力不如 LangGraph，不作为核心框架        |
| **原生 API 封装**                  | ❌ 放弃             | 维护成本极高，无法复用 LangChain/LangGraph 生态         |

### 模型厂商接入表 (LangChain JS)

基于 EXP-003 的架构决策，所有 OpenAI 兼容厂商通过 `OpenAICompatibleAdapter` 统一适配（内部使用 `ChatDeepSeek` + `baseURL` 切换），推理参数通过 `modelKwargs` 注入请求体。

推理模式是**模型的属性**，不是平台的属性。下表按模型厂商（vendor）维度列出：

| 模型厂商              | 推理模式   | 推理字段路径                            | 启用方式 / modelKwargs                     |
| :-------------------- | :--------- | :-------------------------------------- | :----------------------------------------- |
| **DeepSeek**    | always     | `additional_kwargs.reasoning_content` | 选择推理模型 (如 `deepseek-reasoner`)      |
| **Qwen / 通义** | hybrid     | `additional_kwargs.reasoning_content` | `{ enable_thinking: true }`              |
| **Kimi / Moonshot** | always | `additional_kwargs.reasoning_content` | 选择思考模型 (如 `kimi-k2-thinking`)       |
| **GLM / 智谱**  | hybrid     | `additional_kwargs.reasoning_content` | `{ thinking: { type: "enabled" } }`     |
| **MiniMax**     | always     | `additional_kwargs.reasoning_content` | 无需参数（M2 系列 Interleaved Thinking 始终开启） |

> **聚合平台说明**：SiliconFlow（硅基流动）是模型聚合平台，一个 API Key 可调用多个厂商的模型。
> 其推理模式取决于所调用的具体模型（如 MiniMax M2.5 = always），而非平台本身。
> 在 `MODEL_REGISTRY` 中，推理模式按模型（`ModelDefinition.capabilities.reasoningMode`）逐一声明。

推理模式说明：
- **always**：模型始终输出思维链，无需额外参数（如 MiniMax M2 系列、DeepSeek Reasoner）
- **hybrid**：同一模型可在"推理"和"直接回答"间切换，需通过 `ModelDefinition.reasoningKwargs` 显式开启
- **none**：不具备推理能力（未列出）

---

## 2. 架构总览 (Architecture Overview)

### 分层架构

```
┌─────────────────────────────────────────────────────┐
│                    HTTP Layer                       │
│              AiController (REST + SSE)              │
│  ┌─────────┐ ┌──────────────┐ ┌──────────────────┐  │
│  │ /chat   │ │ /chat/stream │ │ /chat/reasoning  │  │
│  └─────────┘ └──────────────┘ └──────────────────┘  │
│  ┌───────────────────────────────────────────────┐  │
│  │ AiExceptionFilter (LangChain 异常 → HTTP 响应) │  │
│  └───────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────┤
│                  Business Layer                     │
│               AiService (编排、调度)                 │
│  - 推理参数编排: MODEL_REGISTRY → resolveModelKwargs │
│  - 非流式: model.invoke() → normalize → Response    │
│  - 流式:   model.stream() → normalize → SSE         │
├───────────┬────────────────┬────────────────────────┤
│  Factory  │  Normalizer    │  Tools / Registry      │
│  模型工厂  │  推理归一化     │  工具注册表             │
├───────────┴────────────────┴────────────────────────┤
│              Provider Adapter Layer                 │
│   IProviderAdapter (接口)                           │
│   ├── OpenAICompatibleAdapter (ChatDeepSeek)        │
│   ├── AnthropicAdapter (未来)                       │
│   └── GoogleAdapter (未来)                          │
├─────────────────────────────────────────────────────┤
│              LangChain Abstraction                  │
│ BaseChatModel / Runnable / HumanMessage / AIMessage │
├─────────────────────────────────────────────────────┤
│                Model Providers                      │
│       DeepSeek  │  Qwen  │  Moonshot  │  GLM        │
└─────────────────────────────────────────────────────┘
```

### 目录结构

```
src/ai/
├── ai.module.ts                 # 模块定义（注册所有 Provider）
├── ai.controller.ts             # HTTP 层（REST 端点 + SSE 流式端点）
├── ai.service.ts                # 核心业务编排层
├── index.ts                     # 统一导出
│
├── providers/                   # 协议适配层（隔离 LangChain 模型类选择）
│   ├── provider-adapter.interface.ts  # IProviderAdapter 接口
│   ├── openai-compatible.adapter.ts   # OpenAI 兼容协议适配器（内部使用 ChatDeepSeek）
│   └── index.ts
│
├── factories/                   # 工厂层（依赖 IProviderAdapter，不直接 import LangChain 模型类）
│   └── model.factory.ts         # AiModelFactory: 委托适配器创建模型
│
├── normalizers/                 # 归一化层
│   └── reasoning.normalizer.ts  # ReasoningNormalizer: 推理字段提取与归一化
│
├── interfaces/                  # 接口与类型定义
│   ├── provider.interface.ts    # Message, StreamChunk, ToolCallInfo 等数据类型
│   ├── model.interface.ts       # ModelDefinition, ModelCapabilities 等模型元数据
│   ├── tool.interface.ts        # IAiTool, ToolDefinition 等工具类型
│   └── agent.interface.ts       # 预留给 LangGraph Agent 的类型定义
│
├── dto/                         # 数据传输对象（请求/响应校验）
│   ├── chat-request.dto.ts      # ChatRequestDto, QuickChatRequestDto
│   └── chat-response.dto.ts     # ChatResponseDto, ReasoningResponseDto
│
├── filters/                     # 异常过滤器
│   └── ai-exception.filter.ts   # AiExceptionFilter: LangChain 异常 → 结构化 HTTP 响应
│
├── constants/                   # 常量、枚举与注册表
│   ├── ai.constants.ts          # AiProvider, StreamChunkType, ReasoningMode, MessageRole
│   └── model-registry.ts        # MODEL_REGISTRY: 模型静态注册表（含 reasoningKwargs）
│
├── tools/                       # 工具注册与管理
│   └── tool.registry.ts         # ToolRegistry: 管理可供 AI 调用的工具
│
└── agents/                      # 智能体（后续章节实现）
    ├── agent.registry.ts        # AgentRegistry: 集中管理所有 Agent 实例
    ├── single/                  # 单智能体（每个 Agent = 一个文件夹）
    │   └── <agent-name>/        #   命名约定：
    │       ├── <name>.state.ts  #     State Annotation 定义
    │       ├── <name>.nodes.ts  #     Node 函数
    │       ├── <name>.graph.ts  #     StateGraph 组装
    │       ├── <name>.agent.ts  #     NestJS Injectable 包装
    │       └── index.ts
    ├── multi/                   # 多智能体协作
    │   └── <workflow-name>/     #   每个 Workflow = 一个文件夹
    │       ├── <name>.graph.ts  #     Supervisor / Workflow 图
    │       ├── sub-agents.ts    #     子 Agent 引用
    │       └── index.ts
    └── shared/                  # 跨 Agent 共享的可复用件
        ├── states/              #   共享 State Annotation
        ├── nodes/               #   通用 Node 函数
        └── tools/               #   公共工具集
```

### 核心组件职责一览

| 组件                    | 职责                                              | 依赖                                        |
| :---------------------- | :------------------------------------------------ | :------------------------------------------ |
| `AiController`        | HTTP 端点，SSE 响应头设置，Observable → SSE 桥接 | `AiService`                               |
| `AiExceptionFilter`   | 拦截 LangChain 非标准异常，映射为结构化 HTTP 响应 | 无（挂载于 Controller 层）                  |
| `AiService`           | 业务编排，调度 Factory 和 Normalizer              | `AiModelFactory`, `ReasoningNormalizer` |
| `AiModelFactory`      | 委托适配器创建模型，不直接依赖 LangChain 模型类   | `ConfigService`, `IProviderAdapter`       |
| `IProviderAdapter`    | 协议适配器接口，隔离 Factory 与 LangChain 类选择  | —                                           |
| `OpenAICompatibleAdapter` | OpenAI 兼容协议适配器（内部使用 ChatDeepSeek） | `@langchain/deepseek`                     |
| `ReasoningNormalizer` | 从 AIMessage(Chunk) 中提取推理字段，输出统一结构  | 无                                          |
| `ToolRegistry`        | 注册、查找、执行 AI 工具                          | 无                                          |
| `AgentRegistry`       | 集中管理所有 Agent 实例的发现和访问               | 无                                          |

---

## 3. 核心组件设计 (Core Components)

### 3.1 模型工厂 + 协议适配器 (AiModelFactory + IProviderAdapter)

**设计要点**：

- **工厂 + 适配器双层结构**：Factory 负责配置解析和编排，Adapter 负责具体的 LangChain 类实例化
- Factory **不直接 import 任何 LangChain 模型类**，具体类选择由 `IProviderAdapter` 实现封装
- 返回值统一为 LangChain 的 `BaseChatModel` 类型，调用方无需关心底层具体类
- 通过 `ConfigService` 从 `.env` 安全读取敏感配置，代码零硬编码
- **数据驱动**：`PROVIDER_REGISTRY` 中每个提供商映射到一个 Adapter 实例 + 默认配置
- **职责纯粹**：Factory 不含推理逻辑；Adapter 不含配置读取逻辑

**扩展方式**：

| 场景 | 操作 |
| :--- | :--- |
| 新增 OpenAI 兼容提供商 | 在 `PROVIDER_REGISTRY` 加一行配置 |
| 新增非 OpenAI 协议提供商 | 创建新 Adapter → 在 `PROVIDER_REGISTRY` 引用 |
| LangChain 修复 ChatOpenAI 推理字段问题 | 只改 `OpenAICompatibleAdapter` 内部一行 |

```typescript
// 协议适配器接口 — Factory 只依赖此接口
interface IProviderAdapter {
  createModel(params: AdapterModelParams): BaseChatModel;
}

// OpenAI 兼容协议适配器 — 封装 ChatDeepSeek 选择（EXP-001/003）
class OpenAICompatibleAdapter implements IProviderAdapter {
  createModel(params: AdapterModelParams): BaseChatModel {
    return new ChatDeepSeek({ apiKey: params.apiKey, model: params.model, ... });
  }
}

// 提供商注册表 — 每个提供商映射到适配器 + 默认配置
const openAICompatible = new OpenAICompatibleAdapter();
const PROVIDER_REGISTRY: Record<string, ProviderEntry> = {
  siliconflow: { adapter: openAICompatible, defaultModel: '...', fallbackBaseUrl: '...' },
  deepseek:    { adapter: openAICompatible, defaultModel: 'deepseek-chat' },
  // 未来: anthropic: { adapter: new AnthropicAdapter(), defaultModel: 'claude-sonnet-4-20250514' },
};

// 工厂内部：委托适配器创建模型
createChatModel(provider: string, options: CreateModelOptions = {}): BaseChatModel {
  const entry = PROVIDER_REGISTRY[provider];
  return entry.adapter.createModel({ apiKey, model, baseUrl, ...options });
}
```

### 3.2 推理字段归一化 (ReasoningNormalizer)

**解决的核心问题**：

各厂商 LLM 返回推理内容的方式各不相同。虽然当前四家厂商恰好都使用 `additional_kwargs.reasoning_content`，但我们不能假设未来新增的厂商也遵循同样的格式。

**设计要点**：

- 采用 **策略模式**，每个厂商注册独立的提取函数
- 未注册的厂商自动回退到默认策略（尝试通用字段位置），保证前向兼容
- 同时处理 `string` 和 `ContentPart[]` 两种 content 格式（兼容未来的多模态场景）
- 返回统一的 `NormalizedChatOutput { content, reasoning }` 结构

```
厂商推理字段位置映射（按模型厂商维度）：

┌──────────────┬────────────────────────────┬──────────────────────────────────────────┐
│ 模型厂商      │ additional_kwargs 字段      │ 启用方式                                 │
├──────────────┼────────────────────────────┼──────────────────────────────────────────┤
│ DeepSeek     │ reasoning_content          │ 推理模型自动开启 (deepseek-reasoner)      │
│ Qwen         │ reasoning_content          │ modelKwargs: { enable_thinking: true }   │
│ Moonshot     │ reasoning_content          │ 思考模型自动开启 (kimi-k2-thinking)       │
│ GLM          │ reasoning_content          │ modelKwargs: { thinking: {type:"enabled"}}│
│ MiniMax      │ reasoning_content          │ 无需参数（M2 系列思考始终开启）            │
└──────────────┴────────────────────────────┴──────────────────────────────────────────┘
```

**使用场景**：

```typescript
// 非流式：一次性提取
const result = await model.invoke(messages);
const normalized = this.reasoningNormalizer.normalize('deepseek', result);
// → { content: '最终答案', reasoning: '推理过程...' }

// 流式：逐片提取，区分推理块和文本块
for await (const chunk of stream) {
  const normalized = this.reasoningNormalizer.normalize('deepseek', chunk);
  if (normalized.reasoning) {
    subject.next({ type: StreamChunkType.REASONING, content: normalized.reasoning });
  }
  if (normalized.content) {
    subject.next({ type: StreamChunkType.TEXT, content: normalized.content });
  }
}
```

### 3.3 异常边界适配 (AiExceptionFilter)

**解决的核心问题**：

全局 `HttpExceptionFilter` 使用 `@Catch(HttpException)` 只捕获 NestJS 体系内的 `HttpException` 及其子类。然而 LangChain 抛出的错误**不继承自 `HttpException`**——它们是 LangChain 自有的错误对象，携带上游厂商的原始状态码和错误信息，但不符合 NestJS 异常接口。

当 LangChain 错误未被捕获时，NestJS 的内置兜底处理器会返回通用的 `500 Internal Server Error`，**丢失所有上游错误语义**（如 401 密钥错误、429 限流、400 参数无效）。

**设计要点**：

1. **`@Catch()` 不传参数**：捕获所有异常类型，因为 LangChain 的错误不是标准 `Error` 子类，无法用具体类型匹配
2. **Controller 级别挂载**：通过 `@UseFilters(AiExceptionFilter)` 仅作用于 `AiController`，避免干扰其他模块的 `HttpException` 处理链
3. **防御性字段提取**：LangChain 错误对象结构不固定，通过逐字段类型检测提取 `status`、`message`、`type`
4. **上游状态码映射**：将上游 HTTP 状态码转换为对客户端有意义的响应码，未知状态码默认 `502 Bad Gateway`（语义："上游服务出了问题"，而非 500 暗示自身代码有 Bug）

**异常处理链路**：

```
AiController 中抛出异常
  ↓
@UseFilters(AiExceptionFilter)  ← @Catch() 匹配一切
  ↓ 命中
extractErrorInfo() 提取上游 status/message/type
  ↓
UPSTREAM_STATUS_MAP 映射 → 401/403/429 直接透传，其他 → 502
  ↓
结构化 JSON 响应 { statusCode, timestamp, path, error, message }
```

**上游状态码映射表**：

| 上游状态码 | 映射后 HTTP 状态码 | 语义                         |
| :--------- | :------------------ | :--------------------------- |
| 400        | 400 Bad Request     | 上游认为请求格式无效         |
| 401        | 401 Unauthorized    | 认证失败（如 API Key 错误）  |
| 403        | 403 Forbidden       | 权限不足                     |
| 429        | 429 Too Many Reqs   | 限流（客户端需做退避重试）   |
| 其他/未知  | 502 Bad Gateway     | 上游服务异常                 |

**非流式 vs 流式的错误处理差异**：

- **非流式端点**（`/chat`、`/chat/reasoning`）：异常由 `AiExceptionFilter` 拦截，返回带正确状态码的 JSON 错误响应
- **流式端点**（`/chat/stream`）：一旦 SSE 响应头已发送（HTTP 200），无法再改变状态码。因此 `AiService.executeStream()` 内部 try-catch 错误，通过 SSE `error` 事件推送给客户端

```typescript
// 非流式：AiExceptionFilter 自动拦截，Service 层无需 try-catch
async chat(dto: ChatRequestDto): Promise<ChatResponseDto> {
  const model = this.modelFactory.createChatModel(dto.provider, { ... });
  const result = await model.invoke(messages); // 异常直接上抛
  return { content: normalized.content };
}

// 流式：已开始写入 SSE，必须在 Service 层 catch 并通过事件推送
private async executeStream(model, provider, messages, subject) {
  try {
    const stream = await model.stream(messages);
    for await (const chunk of stream) { /* ... */ }
  } catch (error) {
    subject.next({ type: StreamChunkType.ERROR, error: error.message });
    subject.complete();
  }
}
```

### 3.4 SSE 流式响应

**设计要点**：

- LangChain 的 `model.stream()` 返回 `AsyncIterable<AIMessageChunk>`
- NestJS 的 SSE 基于 RxJS `Observable`
- 中间的转换链路：`AsyncIterable → ReasoningNormalizer → Subject → Observable → SSE`
- Controller 中的 `setupSseStream()` 辅助方法封装了响应头设置、订阅管理和断连清理
- 流式错误处理策略见 3.3 节「非流式 vs 流式的错误处理差异」

**StreamChunkType 枚举（SSE 事件类型）**：

| 类型            | 用途          | 前端处理建议   |
| :-------------- | :------------ | :------------- |
| `reasoning`   | 推理/思考过程 | 折叠面板中展示 |
| `text`        | 正式文本内容  | 逐字渲染       |
| `tool_call`   | 工具调用请求  | 展示调用中状态 |
| `tool_result` | 工具返回结果  | 展示结果卡片   |
| `done`        | 流结束标记    | 停止加载动画   |
| `error`       | 错误信息      | 展示错误提示   |

**SSE 输出格式示例**：

```
data: {"type":"reasoning","content":"让我分析一下这个问题..."}

data: {"type":"reasoning","content":"首先需要考虑..."}

data: {"type":"text","content":"根据分析，"}

data: {"type":"text","content":"答案是42。"}

data: {"type":"done"}

data: [DONE]
```

---

## 4. 数据流详解 (Data Flow)

### 场景 A: 单次对话（非流式）

```
Client → POST /ai/chat { provider: 'deepseek', model: 'deepseek-chat', messages: [...] }
  → AiController.chat(dto)
    → AiService.chat(dto)
      → AiModelFactory.createChatModel('deepseek', { model, temperature })
        → model.invoke(messages)
          → ReasoningNormalizer.normalize('deepseek', aiMessage)
            → ChatResponseDto { content, reasoning?, usage? }
              → JSON Response
```

### 场景 B: 多轮对话（流式）

```
Client → POST /ai/chat/stream { provider: 'qwen', messages: [msg1, msg2, ...] }
  → AiController.streamChat(dto, res)
    → setupSseStream(res, stream$, ...)
      → AiService.streamChat(dto) → Observable<StreamChunk>
        → AiModelFactory.createChatModel('qwen', { streaming: true })
          → model.stream(messages) → AsyncIterable<AIMessageChunk>
            → for each chunk:
                ReasoningNormalizer.normalize('qwen', chunk)
                → Subject.next({ type: 'text', content: '...' })
                  → SSE: data: {"type":"text","content":"..."}\n\n
```

### 场景 C: 推理对话

推理对话通过 **Service 层编排** 驱动，从 DTO → Service(注册表查询) → Factory(modelKwargs) → API：

1. **推理意图传递**：`reasoningChat()` 强制 `enableReasoning: true`；`chat()` 尊重 DTO 中用户的选择
2. **Service 层解析**：`resolveModelKwargs()` 查 `MODEL_REGISTRY` 获取模型定义，仅当 `reasoningMode=HYBRID` 时将 `ModelDefinition.reasoningKwargs` 传给工厂；ALWAYS/NONE 模型无需额外参数
3. **Factory → Adapter 透传**：工厂委托适配器创建模型，`modelKwargs` 原样传入
4. **推理提取**：`ReasoningNormalizer` 从 `additional_kwargs.reasoning_content` 提取推理内容
5. **流式分类**：推理块以 `StreamChunkType.REASONING` 类型发送，文本块以 `TEXT` 类型发送

**扩展性**：新增 hybrid 模型时，只需在 `MODEL_REGISTRY` 中声明 `reasoningKwargs`，无需修改 Service 或 Factory 代码（OCP）

---

## 5. 最佳实践与坑 (Best Practices & Pitfalls)

### ✅ 推荐做法

1. **统一模型接口**：始终通过 `AiModelFactory` 获取模型实例，业务代码零耦合于具体厂商类
2. **推理归一化**：不直接访问 `additional_kwargs`，始终通过 `ReasoningNormalizer` 提取推理字段
3. **配置外置**：所有 API Key、Base URL 通过 `ConfigService` + `.env` 管理，代码中不出现任何硬编码值
4. **枚举约束**：请求 DTO 中使用 `AiProvider` 枚举校验，将无效提供商拦截在校验层
5. **SSE 规范**：设置 `X-Accel-Buffering: no` 响应头，避免 Nginx 等反向代理缓冲 SSE 流
6. **断连清理**：SSE 端点中监听 `res.on('close')`，客户端断连时取消 Observable 订阅
7. **异常边界隔离**：通过 Controller 级 `@UseFilters` 处理第三方库异常，Service 层保持纯业务逻辑，不写 try-catch（流式端点除外，因 SSE 已发送响应头）
8. **上游状态码语义透传**：对客户端有意义的上游状态码（401/403/429）直接透传，未知错误用 502 而非 500，准确区分"我们的上游出了问题"和"我们自身代码有 Bug"

### ❌ 避免做法

1. **不要用 `@langchain/openai` 包装国内模型**：该包会丢弃 `reasoning_content` 字段
2. **不要在 Factory 中直接 import LangChain 模型类**：通过 `IProviderAdapter` 适配器隔离，具体类选择封装在 Adapter 实现中
3. **不要自行实现 Agent/Orchestrator 接口**：智能体编排由 LangGraph 的 StateGraph 负责
4. **不要硬编码推理字段路径**：厂商可能在后续版本变更字段位置，统一由归一化层维护
5. **不要在 Service 层手动 try-catch 非流式调用的 LangChain 错误**：这会导致异常处理逻辑分散，应由 `AiExceptionFilter` 在 Controller 层统一拦截
6. **不要将 `@Catch()` 全捕获过滤器注册为全局**：会抢夺其他模块的 `HttpException` 处理权，应通过 `@UseFilters` 限定在特定 Controller

---

## 6. 行动导向 (Action Guide)

### Step 1: 安装 LangChain 依赖

**这一步在干什么**: 安装 LangChain 核心包和模型适配包。`@langchain/core` 提供基础抽象，`@langchain/deepseek` 提供 OpenAI 兼容模型的适配（通过 `OpenAICompatibleAdapter` 封装）。不使用 `@langchain/community`（EXP-002：实现质量问题 + 依赖冲突）。

```bash
npm install @langchain/core @langchain/deepseek
```

### Step 2: 配置环境变量

**这一步在干什么**: 在 `.env` 中设置各厂商的 API Key。配置文件 `ai.config.ts` 已定义好从环境变量读取的逻辑，只需填写真实密钥。

```bash
# .env
AI_DEFAULT_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-xxx
QWEN_API_KEY=sk-xxx
MOONSHOT_API_KEY=sk-xxx
GLM_API_KEY=xxx.xxx
```

### Step 3: 启用模型工厂 + 协议适配器

**这一步在干什么**: 工厂通过 `IProviderAdapter` 接口委托适配器创建模型。`OpenAICompatibleAdapter` 内部使用 `ChatDeepSeek`（EXP-003），但这一选择被封装为实现细节，工厂文件中不出现任何 LangChain 模型类的 import。

```typescript
// src/ai/providers/openai-compatible.adapter.ts — 封装 ChatDeepSeek 选择
import { ChatDeepSeek } from '@langchain/deepseek';

export class OpenAICompatibleAdapter implements IProviderAdapter {
  createModel(params: AdapterModelParams): BaseChatModel {
    return new ChatDeepSeek({
      apiKey: params.apiKey, model: params.model,
      ...(params.modelKwargs ? { modelKwargs: params.modelKwargs } : {}),
      ...(params.baseUrl ? { configuration: { baseURL: params.baseUrl } } : {}),
    });
  }
}

// src/ai/factories/model.factory.ts — 委托适配器，不依赖具体 LangChain 类
const openAICompatible = new OpenAICompatibleAdapter();
const PROVIDER_REGISTRY: Record<string, ProviderEntry> = {
  siliconflow: { adapter: openAICompatible, defaultModel: '...', fallbackBaseUrl: '...' },
  deepseek:    { adapter: openAICompatible, defaultModel: 'deepseek-chat' },
  qwen:        { adapter: openAICompatible, defaultModel: 'qwen-plus', fallbackBaseUrl: '...' },
  // 未来: anthropic: { adapter: new AnthropicAdapter(), defaultModel: 'claude-sonnet-4-20250514' },
};

createChatModel(provider: string, options: CreateModelOptions = {}): BaseChatModel {
  const entry = PROVIDER_REGISTRY[provider];
  return entry.adapter.createModel({
    apiKey: this.getApiKey(provider),
    model: options.model || entry.defaultModel,
    baseUrl: this.getBaseUrl(provider) || entry.fallbackBaseUrl,
    ...options,
  });
}
```

### Step 4: 启用 AiService 真实调用

**这一步在干什么**: Service 层负责推理参数编排——查注册表、解析 `reasoningKwargs`、传给工厂。工厂不含推理逻辑。

```typescript
// src/ai/ai.service.ts — 推理参数编排（核心新增方法）
private resolveModelKwargs(
  provider: AiProvider, modelId: string, enableReasoning?: boolean,
): Record<string, unknown> | undefined {
  if (!enableReasoning) return undefined;
  const modelDef = this.findModelDefinition(provider, modelId);
  if (modelDef?.capabilities.reasoningMode === ReasoningMode.HYBRID && modelDef.reasoningKwargs) {
    return modelDef.reasoningKwargs;
  }
  return undefined;
}

// chat 尊重 DTO 中的 enableReasoning
async chat(dto: ChatRequestDto): Promise<ChatResponseDto> {
  const modelKwargs = this.resolveModelKwargs(dto.provider, dto.model, dto.enableReasoning);
  const model = this.modelFactory.createChatModel(dto.provider, {
    model: dto.model,
    temperature: dto.temperature,
    modelKwargs, // 如 hybrid 模型的 { enable_thinking: true }
  });
  const result = await model.invoke(messages);
  const normalized = this.reasoningNormalizer.normalize(dto.provider, result);
  return { content: normalized.content, reasoning: normalized.reasoning ?? undefined };
}

// reasoningChat 强制开启推理
async reasoningChat(dto: ChatRequestDto): Promise<ReasoningResponseDto> {
  const modelKwargs = this.resolveModelKwargs(dto.provider, dto.model, true);
  const model = this.modelFactory.createChatModel(dto.provider, {
    model: dto.model,
    modelKwargs,
  });
  // ...
}
```

### Step 5: 验证推理归一化

**这一步在干什么**: 使用支持推理的模型发送请求，验证 `ReasoningNormalizer` 是否正确提取推理内容。

```bash
# 非流式推理测试
curl -X POST http://localhost:3000/ai/chat/reasoning \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "deepseek",
    "model": "deepseek-reasoner",
    "messages": [{"role": "user", "content": "9.9和9.11哪个大？"}]
  }'

# 流式推理测试
curl -N -X POST http://localhost:3000/ai/chat/stream/reasoning \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "deepseek",
    "model": "deepseek-reasoner",
    "messages": [{"role": "user", "content": "9.9和9.11哪个大？"}]
  }'
```

**预期结果**：

- 非流式：响应包含 `content`（最终答案）和 `reasoning`（思考过程）两个字段
- 流式：先收到 `type: "reasoning"` 的 SSE 事件，再收到 `type: "text"` 的事件

---

> **后续章节**：
>
> - **LangGraph 智能体构建**：StateGraph、ReAct Agent、工具调用循环
> - **多智能体协作**：Subgraph、Handoffs、Supervisor 模式
> - **前端流适配**：Vercel AI SDK Data Stream Protocol 对接 → 方案设计已完成，详见 [040. 前端流适配方案设计](040-vercel-ai-sdk-integration-design.md)
> - **持久化层**：基于 Redis / PostgreSQL 的 Checkpointer（状态管理）
