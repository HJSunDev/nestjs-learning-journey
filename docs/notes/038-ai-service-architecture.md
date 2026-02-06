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
| **AiModelFactory**      | 工厂层     | 按配置动态实例化对应厂商的 LangChain Model，封装 API Key / Base URL 等细节           |
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

| 厂商                      | LangChain 类          | 来源包                   | 推理字段路径                            | 启用方式                                |
| :------------------------ | :-------------------- | :----------------------- | :-------------------------------------- | :-------------------------------------- |
| **DeepSeek**        | `ChatDeepSeek`      | `@langchain/deepseek`  | `additional_kwargs.reasoning_content` | 使用推理模型 (如 `deepseek-reasoner`) |
| **Qwen / 通义**     | `ChatAlibabaTongyi` | `@langchain/community` | `additional_kwargs.reasoning_content` | 参数 `enable_thinking: true`          |
| **Kimi / Moonshot** | `ChatMoonshot`      | `@langchain/community` | `additional_kwargs.reasoning_content` | 使用思考模型 (如 `kimi-k2`)           |
| **GLM / 智谱**      | `ChatZhipuAI`       | `@langchain/community` | `additional_kwargs.reasoning_content` | 使用思考模型 (如 `glm-z1-thinking`)   |

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
├─────────────────────────────────────────────────────┤
│                  Business Layer                     │
│               AiService (编排、调度)                 │
│  - 非流式: model.invoke() → normalize → Response    │
│  - 流式:   model.stream() → normalize → SSE         │
├───────────┬────────────────┬────────────────────────┤
│  Factory  │  Normalizer    │  Tools / Registry      │
│  模型工厂  │  推理归一化     │  工具注册表             │
├───────────┴────────────────┴────────────────────────┤
│              LangChain Abstraction                  │
│ BaseChatModel / Runnable / HumanMessage / AIMessage│
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
├── factories/                   # 工厂层
│   └── model.factory.ts         # AiModelFactory: 按厂商实例化 LangChain Model
│
├── normalizers/                 # 归一化层
│   └── reasoning.normalizer.ts  # ReasoningNormalizer: 推理字段提取与归一化
│
├── interfaces/                  # 接口与类型定义
│   ├── provider.interface.ts    # Message, StreamChunk, ToolCallInfo 等数据类型
│   ├── tool.interface.ts        # IAiTool, ToolDefinition 等工具类型
│   └── agent.interface.ts       # 预留给 LangGraph Agent 的类型定义
│
├── dto/                         # 数据传输对象（请求/响应校验）
│   ├── chat-request.dto.ts      # ChatRequestDto, QuickChatRequestDto
│   └── chat-response.dto.ts     # ChatResponseDto, ReasoningResponseDto
│
├── constants/                   # 常量与枚举
│   └── ai.constants.ts          # AiProvider, StreamChunkType, MessageRole
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
| `AiService`           | 业务编排，调度 Factory 和 Normalizer              | `AiModelFactory`, `ReasoningNormalizer` |
| `AiModelFactory`      | 按提供商 + 配置创建 LangChain Model 实例          | `ConfigService`                           |
| `ReasoningNormalizer` | 从 AIMessage(Chunk) 中提取推理字段，输出统一结构  | 无                                          |
| `ToolRegistry`        | 注册、查找、执行 AI 工具                          | 无                                          |
| `AgentRegistry`       | 集中管理所有 Agent 实例的发现和访问               | 无                                          |

---

## 3. 核心组件设计 (Core Components)

### 3.1 模型工厂 (AiModelFactory)

**设计要点**：

- 遵循 **工厂模式**，将模型实例化的复杂逻辑（API Key、Base URL、厂商特有参数）封装在内部
- 返回值统一为 LangChain 的 `BaseChatModel` 类型，调用方无需关心底层具体类
- 通过 `ConfigService` 从 `.env` 安全读取敏感配置，代码零硬编码

```typescript
// 调用方式（AiService 中）
const model = this.modelFactory.createChatModel('deepseek', {
  model: 'deepseek-chat',
  temperature: 0.7,
  streaming: true,
});

// 工厂内部（安装 LangChain 后的真实实现）
private createDeepSeekModel(apiKey: string, options: any): BaseChatModel {
  return new ChatDeepSeek({
    apiKey,
    model: options.model || 'deepseek-chat',
    temperature: options.temperature,
    streaming: options.streaming,
  });
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
厂商推理字段位置映射：

┌──────────┬────────────────────────────┬────────────────────────────────┐
│ 厂商     │ additional_kwargs 字段      │ 启用方式                       │
├──────────┼────────────────────────────┼────────────────────────────────┤
│ DeepSeek │ reasoning_content          │ 使用推理模型 (deepseek-reasoner)│
│ Qwen     │ reasoning_content          │ enable_thinking: true          │
│ Moonshot │ reasoning_content          │ 使用思考模型 (kimi-k2)          │
│ GLM      │ reasoning_content          │ 使用思考模型 (glm-z1-thinking)  │
└──────────┴────────────────────────────┴────────────────────────────────┘
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

### 3.3 SSE 流式响应

**设计要点**：

- LangChain 的 `model.stream()` 返回 `AsyncIterable<AIMessageChunk>`
- NestJS 的 SSE 基于 RxJS `Observable`
- 中间的转换链路：`AsyncIterable → ReasoningNormalizer → Subject → Observable → SSE`
- Controller 中的 `setupSseStream()` 辅助方法封装了响应头设置、订阅管理和断连清理

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

与普通对话流程完全一致，区别在于：

1. **模型选择**：使用推理模型（如 `deepseek-reasoner`、`glm-z1-thinking`）
2. **推理提取**：`ReasoningNormalizer` 从 `additional_kwargs.reasoning_content` 提取出推理内容
3. **流式分类**：推理块以 `StreamChunkType.REASONING` 类型发送，文本块以 `TEXT` 类型发送

---

## 5. 最佳实践与坑 (Best Practices & Pitfalls)

### ✅ 推荐做法

1. **统一模型接口**：始终通过 `AiModelFactory` 获取模型实例，业务代码零耦合于具体厂商类
2. **推理归一化**：不直接访问 `additional_kwargs`，始终通过 `ReasoningNormalizer` 提取推理字段
3. **配置外置**：所有 API Key、Base URL 通过 `ConfigService` + `.env` 管理，代码中不出现任何硬编码值
4. **枚举约束**：请求 DTO 中使用 `AiProvider` 枚举校验，将无效提供商拦截在校验层
5. **SSE 规范**：设置 `X-Accel-Buffering: no` 响应头，避免 Nginx 等反向代理缓冲 SSE 流
6. **断连清理**：SSE 端点中监听 `res.on('close')`，客户端断连时取消 Observable 订阅

### ❌ 避免做法

1. **不要用 `@langchain/openai` 包装国内模型**：该包会丢弃 `reasoning_content` 字段
2. **不要自行实现 Provider 抽象层**：LangChain 的 `BaseChatModel` 已经是工业级的 Provider 抽象
3. **不要自行实现 Agent/Orchestrator 接口**：智能体编排由 LangGraph 的 StateGraph 负责
4. **不要硬编码推理字段路径**：厂商可能在后续版本变更字段位置，统一由归一化层维护

---

## 6. 行动导向 (Action Guide)

### Step 1: 安装 LangChain 依赖

**这一步在干什么**: 安装 LangChain 核心包和各厂商的模型适配包。`@langchain/core` 提供基础抽象，`@langchain/deepseek` 和 `@langchain/community` 提供具体厂商实现。

```bash
npm install @langchain/core @langchain/deepseek @langchain/community
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

### Step 3: 启用模型工厂真实实现

**这一步在干什么**: 将 `model.factory.ts` 中的 mock 占位替换为真实的 LangChain 实例化代码。每个工厂方法对应一个厂商的 LangChain 类。

```typescript
// src/ai/factories/model.factory.ts
import { ChatDeepSeek } from '@langchain/deepseek';
import {
  ChatAlibabaTongyi,
  ChatMoonshot,
  ChatZhipuAI,
} from '@langchain/community/chat_models';

private createDeepSeekModel(apiKey: string, options: any): BaseChatModel {
  return new ChatDeepSeek({
    apiKey,
    model: options.model || 'deepseek-chat',
    temperature: options.temperature,
    streaming: options.streaming,
  });
}

private createQwenModel(apiKey: string, options: any): BaseChatModel {
  return new ChatAlibabaTongyi({
    alibabaApiKey: apiKey,
    model: options.model || 'qwen-turbo',
    temperature: options.temperature,
    streaming: options.streaming,
  });
}

private createMoonshotModel(apiKey: string, options: any): BaseChatModel {
  return new ChatMoonshot({
    apiKey,
    model: options.model || 'moonshot-v1-8k',
    temperature: options.temperature,
    streaming: options.streaming,
  });
}

private createZhipuModel(apiKey: string, options: any): BaseChatModel {
  return new ChatZhipuAI({
    zhipuAIApiKey: apiKey,
    model: options.model || 'glm-4',
    temperature: options.temperature,
    streaming: options.streaming,
  });
}
```

### Step 4: 启用 AiService 真实调用

**这一步在干什么**: 将 `ai.service.ts` 中的 mock 流替换为真实的 LangChain `invoke` / `stream` 调用。归一化层已就绪，只需取消注释并删除 mock 代码。

```typescript
// src/ai/ai.service.ts — 非流式
async chat(dto: ChatRequestDto): Promise<ChatResponseDto> {
  const model = this.modelFactory.createChatModel(dto.provider, {
    model: dto.model,
    temperature: dto.temperature,
  });

  const result = await model.invoke(dto.messages);
  const normalized = this.reasoningNormalizer.normalize(dto.provider, result);

  return {
    content: normalized.content,
    reasoning: normalized.reasoning ?? undefined,
  };
}

// src/ai/ai.service.ts — 流式核心逻辑
private async executeStream(model, provider, messages, subject, includeReasoning) {
  const stream = await model.stream(messages);
  for await (const chunk of stream) {
    const normalized = this.reasoningNormalizer.normalize(provider, chunk);
    if (normalized.reasoning && includeReasoning) {
      subject.next({ type: StreamChunkType.REASONING, content: normalized.reasoning });
    }
    if (normalized.content) {
      subject.next({ type: StreamChunkType.TEXT, content: normalized.content });
    }
  }
  subject.next({ type: StreamChunkType.DONE });
  subject.complete();
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
> - **前端流适配**：Vercel AI SDK Data Stream Protocol 对接
> - **持久化层**：基于 Redis / PostgreSQL 的 Checkpointer（状态管理）
