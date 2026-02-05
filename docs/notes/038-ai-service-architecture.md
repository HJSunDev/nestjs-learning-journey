# 038. AI 服务模块架构设计 (AI Service Architecture)

## 1. 核心问题与概念 (The "Why")

### 解决什么问题

在 NestJS 后端中集成 AI 能力，我们从最初的简单对话需求升级到了构建复杂智能体（Agent）系统。架构需要解决以下痛点：

1.  **多模型厂商适配**：DeepSeek、Qwen (通义千问)、Moonshot (Kimi)、GLM (智谱)、OpenAI 等，API 标准各异。
2.  **从 Chat 到 Agent 的演进**：简单的 Request/Response 模式已无法满足需求，我们需要 State Management（状态管理）、Tool Calling（工具调用）、Human-in-the-loop（人机交互）等高级能力。
3.  **流式响应标准化**：无论是简单的对话流，还是复杂的 Agent 思考过程流，前端都需要统一的消费体验。
4.  **推理过程（Reasoning）支持**：DeepSeek R1 等模型引入了“思考过程”，架构必须支持将这一特殊数据段透传给前端。

### 核心概念与依赖

我们采用 **LangChain / LangGraph** 作为内核，**Vercel AI SDK** 作为前端协议适配层。

| 概念 | 说明 |
| :--- | :--- |
| **LangChain Core** | 提供 `BaseChatModel`、`Runnable` 等核心抽象，统一不同厂商的模型接口。 |
| **LangGraph** | 用于构建有状态的、多步骤的 Agent 应用（Stateful, Multi-Actor Applications）。它是构建复杂智能体的最佳实践。 |
| **Model Factory** | 工厂模式，根据配置动态产出对应的 LangChain Model 实例。 |
| **Vercel AI SDK (UI)** | 虽然后端核心逻辑迁移至 LangChain，但前端仍推荐使用 Vercel 的 `useChat` 协议。后端需做适配。 |

### 技术选型决策

| 方案 | 优点 | 缺点 | 决策 |
| :--- | :--- | :--- | :--- |
| **LangChain + LangGraph** | 工业级 Agent 标准，图编排能力强，生态丰富 | 学习曲线陡峭，抽象层较多 | ✅ **内核采用** |
| **Vercel AI SDK (Core)** | 简单易用，流式支持好 | Agent 能力（特别是复杂状态管理）不如 LangGraph | ⚠️ **仅作适配层** |
| **原生 API 封装** | 极致轻量 | 维护成本极高，难以复用 Agent 逻辑 | ❌ **放弃** |

### 模型厂商接入表 (LangChain JS)

| 厂商 | 对应的类 (Class) | 来源包 (Package) | 备注 |
| :--- | :--- | :--- | :--- |
| **DeepSeek** | `ChatDeepSeek` | `@langchain/deepseek` | 官方支持，支持 reasoning_content |
| **Qwen / 通义** | `ChatAlibabaTongyi` | `@langchain/community` | 阿里官方维护的社区包 |
| **Kimi / Moonshot** | `ChatMoonshot` | `@langchain/community` | 社区支持 |
| **GLM / 智谱** | `ChatZhipuAI` | `@langchain/community` | 社区支持 |

---

## 2. 核心架构设计 (Architecture Design)

### 模块结构

```
src/ai/
├── ai.module.ts                    # 模块定义
├── ai.controller.ts                # HTTP 控制器 (SSE, REST)
├── ai.service.ts                   # 业务外观层 (Facade)
├── index.ts                        # 统一导出
│
├── factories/                      # [NEW] 工厂层
│   └── model.factory.ts            # ModelFactory: 负责实例化 LangChain Models
│
├── agents/                         # [NEW] 智能体层
│   ├── agent.builder.ts            # AgentGraphBuilder: 构建 LangGraph 图
│   └── agent.executor.ts           # 负责运行 Agent 并处理流事件
│
├── interfaces/
│   ├── chat-model.interface.ts     # 统一的模型接口定义
│   └── ai-config.interface.ts      # 配置接口
│
├── dto/
│   ├── chat-request.dto.ts         # 请求 DTO
│   └── chat-response.dto.ts        # 响应 DTO
```

### 数据流向 (Data Flow)

#### 场景 A: 简单对话 (Simple Chat)

1.  **Request**: 用户发送 `provider: 'deepseek'`, `message: 'hello'`
2.  **Controller**: 调用 `AiService.chatStream()`
3.  **AiService**: 调用 `ModelFactory.create('deepseek')` 获取 `ChatDeepSeek` 实例
4.  **Execution**: 调用 `model.stream(messages)`
5.  **Adaptation**: 将 LangChain 的 `AIMessageChunk` 转换为前端可读的 SSE 流 (Vercel Data Stream Protocol)
6.  **Response**: SSE 推送给前端

#### 场景 B: 智能体执行 (Agent Execution)

1.  **Request**: 用户发送复杂任务
2.  **AiService**: 调用 `AgentBuilder` 构建或获取缓存的 `CompiledGraph`
3.  **Execution**: 运行 `graph.streamEvents()`
4.  **Adaptation**: 监听 `on_chat_model_stream` 等事件，过滤并转换为统一流格式
5.  **Response**: 包含 "思考过程"、"工具调用"、"最终答案" 的混合流

---

## 3. 关键代码骨架 (Skeleton Code)

### Model Factory (核心)

工厂模式将“如何创建模型”的复杂逻辑（API Key 获取、参数配置、BaseURL 设置）封装起来。

```typescript
// src/ai/factories/model.factory.ts
@Injectable()
export class AiModelFactory {
  constructor(private configService: ConfigService) {}

  createChatModel(provider: string, options?: any): BaseChatModel {
    const apiKey = this.getApiKey(provider);
    
    switch (provider) {
      case 'deepseek':
        // 伪代码：实际需安装 @langchain/deepseek
        // return new ChatDeepSeek({ apiKey, model: 'deepseek-chat', ...options });
        return null; 
      case 'qwen':
        // 伪代码：实际需安装 @langchain/community
        // return new ChatAlibabaTongyi({ alibabaApiKey: apiKey, ...options });
        return null;
      // ... 其他厂商
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }
}
```

### AiService (编排)

```typescript
// src/ai/ai.service.ts
@Injectable()
export class AiService {
  constructor(private modelFactory: AiModelFactory) {}

  async streamChat(dto: ChatRequestDto): Promise<Observable<any>> {
    const model = this.modelFactory.createChatModel(dto.provider);
    
    // 将 LangChain 的 Promise stream 转换为 NestJS Observable
    return new Observable(subscriber => {
      (async () => {
        try {
          const stream = await model.stream(dto.messages);
          for await (const chunk of stream) {
            // 这里处理数据格式转换，适配前端
            subscriber.next(this.formatChunk(chunk));
          }
          subscriber.complete();
        } catch (err) {
          subscriber.error(err);
        }
      })();
    });
  }
}
```

---

## 4. 下一步行动 (Action Plan)

1.  **依赖安装 (Pending)**: 等待架构确认后，安装 LangChain 相关包。
2.  **工厂实现**: 填充 `ModelFactory` 的具体实例化逻辑。
3.  **Agent 引入**: 引入 LangGraph，设计第一个 ReAct Agent。
4.  **流适配器**: 编写 `LangChainToVercelAdapter`，确保前端兼容性。
