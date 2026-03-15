# 046. 生产级可观测性与韧性 (Observability & Resilience)

## 1. 核心问题与概念 (The "Why")

### 解决什么问题

在 041-045 章节中，我们构建了完整的 LCEL 管道、工具调用循环、RAG 检索链等 AI 链路。这些链路在开发环境工作正常，但在生产环境中面临两个关键挑战：

1. **不可观测**：LLM 调用是黑盒——不知道每次请求的耗时分布、token 消耗、哪个环节慢、是否有隐性错误
2. **不够韧性**：LLM API 存在瞬时故障（429 限流、502 网关错误、超时），单次失败直接返回错误会严重影响用户体验

### 核心概念与依赖

- **LangChain Callbacks**：`@langchain/core` 提供的生命周期钩子系统。通过继承 `BaseCallbackHandler` 可以拦截 LLM / Chain / Tool / Retriever 各环节的 start / end / error 事件，实现非侵入式观测
- **`.withRetry()`**：`Runnable` 原型链上的方法，对瞬时错误自动重试。内部使用指数退避（exponential backoff）算法
- **`.withFallbacks()`**：`Runnable` 原型链上的方法，当主链（含重试）全部失败后，按顺序尝试备用链
- **Trace / Span 模型**：借鉴 OpenTelemetry 的追踪模型——一次完整请求产生一个 Trace，其中每个独立操作（LLM 调用、工具执行、检索）产生一个 Span

### 架构决策

**为什么不用 LangSmith / Langfuse？**

- LangSmith 是 LangChain 的官方 SaaS 追踪平台，功能强大但引入外部依赖和网络延迟
- Langfuse 是开源替代方案，但需要额外部署服务
- 本章选择**零外部依赖**的自实现方案：继承 `BaseCallbackHandler` + 复用项目已有的 Winston 日志体系，满足 90% 的生产观测需求
- 与 EXP-004 的"自实现而非引入重量级依赖"策略一脉相承

## 2. 核心用法 / 方案设计 (Usage / Design)

### 场景 A: per-request 链路追踪

每次 AI 请求创建独立的 `LangChainTracer` 实例，通过 `callbacks` 参数注入：

```typescript
const tracer = new LangChainTracer(this.logger);

const result = await chain.invoke(input, {
  callbacks: [tracer],
});

// 获取结构化追踪摘要
const summary = tracer.logSummary();
// → [Trace] traceId=trace_1710... | totalMs=1523 | llmCalls=1 | llmMs=1200 | tokens=580(in=120,out=460)
```

LangChain 会自动将回调向下传播到 chain 中的所有嵌套组件（model、tools、retriever），无需手动逐层挂载。

### 场景 B: 重试瞬时错误

使用 `.withRetry()` 对 429 限流、502 网关等瞬时错误自动重试：

```typescript
import { ResilienceService } from './resilience';

// 通过服务包装
const resilientChain = this.resilienceService.withRetry(chain, {
  maxAttempts: 2, // 最多重试 2 次（总共调用 3 次）
});

// 或直接使用 LangChain 原生 API
const resilientChain = chain.withRetry({
  stopAfterAttempt: 3,
});
```

### 场景 C: 多模型降级

当主模型不可用时自动切换到备用模型：

```typescript
// 主模型：DeepSeek
const primaryChain = prompt.pipe(deepseekModel);

// 备用模型：SiliconFlow
const fallbackChain = prompt.pipe(siliconflowModel);

// 组合：主模型失败 → 尝试备用
const resilientChain = primaryChain.withFallbacks({
  fallbacks: [fallbackChain],
});
```

### 场景 D: 组合重试 + 降级

生产级最佳实践——每个模型都有重试能力，重试耗尽后切换到下一个模型：

```typescript
const primaryWithRetry = this.resilienceService.withRetry(primaryChain);
const fallbackWithRetry = this.resilienceService.withRetry(fallbackChain);

const fullResilient = primaryWithRetry.withFallbacks({
  fallbacks: [fallbackWithRetry],
});
```

### 场景 E: 单次 LLM 调用超时（Per-Call Timeout）

每次 LLM HTTP 请求都有独立的超时限制，防止单次调用无限挂起：

```typescript
// AiModelFactory 在创建模型时自动注入 perCallMs（默认 60s）
const model = this.modelFactory.createChatModel('deepseek', {
  model: 'deepseek-chat',
  timeout: 30000, // 可覆盖默认值，设置 30s
});

// 底层透传给 ChatDeepSeek 构造函数，作用于 Axios HTTP 层
// 若 60s 内未收到响应，Axios 抛出 ECONNABORTED 错误
```

`timeout` 在整个链路中的传递路径：

```
CreateModelOptions.timeout
  → AiModelFactory（缺省时读取 ai.timeout.perCallMs 配置）
    → AdapterModelParams.timeout
      → OpenAICompatibleAdapter
        → ChatDeepSeek({ timeout })
          → Axios({ timeout })  ← 实际生效的 HTTP 超时
```

### 场景 F: 工具调用循环聚合超时（Loop-Level Timeout）

对多轮工具调用的总耗时设置上限，防止 HTTP 请求被无限占用：

```typescript
// ToolCallingLoop 通过 AbortController 控制整个循环的生命周期
const result = await this.toolCallingLoop.execute({
  model,
  messages,
  toolNames: ['get_weather', 'search_web'],
  maxIterations: 5,
  timeoutMs: 120000, // 120s 总超时（可选，缺省使用 ai.timeout.toolCallingLoopMs）
});

// 超时触发时：
// 1. AbortController.abort() 中止当前正在执行的 model.invoke()
// 2. 抛出包含调试上下文的错误：
//    "工具调用循环超时: 已执行 120050ms (限制 120000ms), 完成 3 轮工具调用后中止"
// 3. AiExceptionFilter 捕获后映射为 504 Gateway Timeout
```

**与 maxIterations 的关系**：`maxIterations` 限制轮次数（防止逻辑死循环），`timeoutMs` 限制挂钟时间（防止慢响应耗尽资源）。两者独立生效，互为补充。

**适用边界**：`toolCallingLoopMs` 仅保护 ToolCallingLoop 这种同步 HTTP 请求内的工具调用循环。未来 LangGraph 的异步长时运行智能体有独立的任务级 TTL 和步骤超时机制，不受此参数影响。

## 3. 深度原理与机制 (Under the Hood)

### 3.1 LangChain Callbacks 传播机制

```
chain.invoke(input, { callbacks: [tracer] })
  │
  ├── handleChainStart(chain, input, runId)
  │     │
  │     ├── handleLLMStart(model, prompts, runId, parentRunId=chainRunId)
  │     │     │
  │     │     └── [模型推理中...]
  │     │
  │     ├── handleLLMEnd(output, runId)
  │     │
  │     └── (如果有 tool_calls)
  │           ├── handleToolStart(tool, input, runId, parentRunId)
  │           ├── handleToolEnd(output, runId)
  │           └── handleLLMStart(...)  ← 二次推理
  │
  └── handleChainEnd(outputs, runId)
```

**关键设计**：

- 每个操作分配唯一的 `runId`，嵌套操作通过 `parentRunId` 构建调用树
- 回调在 `invoke/stream` 的 `config` 中传入后自动向下传播
- `handleLLMEnd` 的 `LLMResult.llmOutput` 包含 token 用量信息

### 3.2 .withRetry() 底层实现

```
chain.withRetry({ stopAfterAttempt: 3 })
  │
  └── 返回 RunnableRetry 实例（装饰者模式包装原始 Runnable）
        │
        invoke(input)
          ├── 尝试 1: 调用原始 Runnable → 成功 → 返回结果
          │         └── 失败 → 检查错误是否可重试
          ├── 等待 (指数退避: ~200ms)
          ├── 尝试 2: 调用原始 Runnable → 成功 → 返回结果
          │         └── 失败
          ├── 等待 (~400ms)
          └── 尝试 3: 最终尝试 → 成功/失败
```

**重试判定**：LangChain 默认重试所有异常。可通过 `onFailedAttempt` 回调记录每次失败。

### 3.3 .withFallbacks() 底层实现

```
primary.withFallbacks({ fallbacks: [fb1, fb2] })
  │
  └── 返回 RunnableWithFallbacks 实例
        │
        invoke(input)
          ├── 调用 primary → 成功 → 返回结果
          │        └── 失败
          ├── 调用 fb1 → 成功 → 返回结果
          │        └── 失败
          └── 调用 fb2 → 成功/失败（最终结果）
```

**流式限制**：在 `stream()` 调用中，fallback 仅在流创建阶段（`.stream()` 方法返回前）的错误触发降级。流开始传输数据后的错误不会触发降级。

### 3.4 Tracer 存储模型：为什么不需要数据库

`LangChainTracer` 的核心是一个 `Map<runId, TraceSpan>`，维护在内存中，随请求结束被 GC 回收。这不是偷懒——这是刻意的分层设计：

```
┌─────────────────────────────────────────────────────────┐
│ 请求生命周期                                             │
│                                                         │
│  new Tracer() → Map 缓冲 Span → logSummary() 聚合输出    │
│       ↑                              ↓                  │
│   GC 回收 ←─── 请求结束         Winston JSON 日志        │
│                                      ↓                  │
│                          logs/combined-2026-03-14.log   │
│                                      ↓                  │
│                          ELK / Loki / Grafana (可选)    │
└─────────────────────────────────────────────────────────┘
```

**Map 的职责是"计算"**：在请求期间聚合各 Span 的 startTime/endTime/tokenUsage，`logSummary()` 调用时一次性汇总为 `TraceSummary`。

**Winston 的职责是"持久化"**：`logSummary()` 通过 NestJS Logger 输出的结构化日志，被 Winston 以 JSON 格式写入带日期轮转的日志文件（参见 013 章节的 Winston 配置）。这些日志文件就是追踪数据的持久化层。

**为什么不直接写数据库？**

- LLM 调用本身就慢（1-10 秒），追踪层不应引入额外 I/O 延迟
- 日志文件是天然的 append-only 存储，写入成本接近零
- 需要检索分析时，接入 ELK / Loki 即可——这是运维层的事，不应耦合到应用层

#### 生产级可观测性的 4 个层级

| 层级                    | 方案                                        | 数据存储   | 适用阶段                | 当前状态  |
| ----------------------- | ------------------------------------------- | ---------- | ----------------------- | --------- |
| **L1 日志驱动**   | `LangChainTracer` → Winston JSON         | 日志文件   | MVP / 中小规模          | ✅ 已实现 |
| **L2 指标聚合**   | 导出 latency/tokens/errorRate → Prometheus | 时序数据库 | 需要告警和仪表盘        | 扩展方向  |
| **L3 分布式追踪** | 接入 OpenTelemetry → Jaeger/Zipkin         | 追踪存储   | 微服务 / 跨服务链路     | 扩展方向  |
| **L4 LLM 专用**   | LangSmith / Langfuse                        | 专用平台   | 需要 prompt 评估 / 微调 | 扩展方向  |

关键洞察：**每层演进只需替换 `logSummary()` 的输出目标，或新增一个并行的 `CallbackHandler`**——不需要改动链或模型的任何代码。这正是回调架构（观察者模式）的核心优势：观测逻辑与业务逻辑完全解耦。

### 3.5 TraceSummary 数据模型

```typescript
interface TraceSummary {
  traceId: string;           // 贯穿一次完整请求的唯一标识
  totalLatencyMs: number;    // 请求总耗时
  llmCallCount: number;      // LLM 调用次数（重试会增加此计数）
  llmTotalLatencyMs: number; // LLM 调用总耗时
  totalTokenUsage: {         // 所有 LLM 调用的累计 token
    input: number;
    output: number;
    total: number;
  };
  toolCallCount: number;     // 工具调用次数
  retrieverCallCount: number; // 检索操作次数
  hasError: boolean;
  firstError?: string;
  spans: TraceSpan[];        // 所有操作的详细记录
}
```

### 3.6 超时控制双层架构

超时保护分两层独立运作，覆盖不同粒度的风险：

```
┌─────────────────────────────────────────────────────────────────┐
│                   超时控制双层架构                               │
│                                                                 │
│  Layer 1: Per-Call Timeout (单次 HTTP 请求超时)                  │
│  ─────────────────────────────────────────────                  │
│  注入点: AiModelFactory.createChatModel()                        │
│  生效位置: ChatDeepSeek → Axios HTTP Client                      │
│  作用: 单次 LLM API 请求超过 perCallMs 即中止                     │
│  配置: ai.timeout.perCallMs (默认 60s)                           │
│                                                                 │
│  Layer 2: Loop-Level Timeout (循环聚合超时)                      │
│  ──────────────────────────────────────────                     │
│  注入点: ToolCallingLoop.execute() / streamExecute()             │
│  生效位置: AbortController.signal → 传递给每次 invoke/stream      │
│  作用: 多轮工具调用的总挂钟时间超过 toolCallingLoopMs 即中止整个循环 │
│  配置: ai.timeout.toolCallingLoopMs (默认 300s, 0=不限制)         │
│                                                                 │
│  错误收敛: AiExceptionFilter                                     │
│  ─────────────────────────                                      │
│  AbortError / ECONNABORTED / ETIMEDOUT / 含"超时"的消息          │
│  → 统一映射为 504 Gateway Timeout                                │
└─────────────────────────────────────────────────────────────────┘
```

#### 两层的独立性与互补性

| 风险场景 | Layer 1 (perCallMs) | Layer 2 (toolCallingLoopMs) |
| --- | --- | --- |
| 单次 LLM 推理卡住不返回 | ✅ 直接中止 | 间接生效（循环也会终止） |
| 单次调用正常，但 5 轮循环总耗时过长 | ❌ 无法感知 | ✅ 超过总时限时中止 |
| 工具执行本身耗时过长 | ❌ 不覆盖工具执行 | ✅ 整体超时兜底 |

#### AbortController 信号传递路径

```typescript
// ToolCallingLoop.createTimeoutGuard()
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), resolvedTimeout);

// signal 传递给每次 LLM 调用
await modelWithTools.invoke(currentMessages, { signal: controller.signal });

// 超时触发时:
// 1. controller.abort() 设置 signal.aborted = true
// 2. LangChain 的 invoke/stream 检测到 aborted signal，抛出 AbortError
// 3. handleLoopError() 捕获 AbortError，包装为带上下文的业务错误
// 4. AiExceptionFilter 检测到超时错误，返回 504
```

#### 配置与环境变量映射

```typescript
// ai.config.ts
timeout: {
  perCallMs: parseInt(process.env.AI_TIMEOUT_PER_CALL || '60000', 10),
  toolCallingLoopMs: parseInt(process.env.AI_TIMEOUT_TOOL_CALLING_LOOP || '300000', 10),
}

// .env 可选覆盖
// AI_TIMEOUT_PER_CALL=60000           # 单次调用 60s
// AI_TIMEOUT_TOOL_CALLING_LOOP=300000 # 循环总计 300s, 设为 0 不限制
```

#### 与未来 LangGraph 智能体的边界

`toolCallingLoopMs` 的命名和作用域被刻意限定为 ToolCallingLoop——即同步 HTTP 请求内的工具调用循环。未来 LangGraph 的异步长时运行智能体（可能持续数分钟甚至数小时）有独立的超时机制：

| 超时类型 | ToolCallingLoop | LangGraph Agent (未来) |
| --- | --- | --- |
| 执行模式 | 同步（HTTP 请求内） | 异步（后台任务） |
| 超时控制 | `toolCallingLoopMs` | 任务级 TTL + 步骤超时 |
| 配置位置 | `ai.timeout.toolCallingLoopMs` | 独立的 agent 配置 |

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

- ✅ **per-request 创建 Tracer**：每次请求 `new LangChainTracer()`，避免跨请求状态污染
- ✅ **callbacks 通过 config 传入**：`chain.invoke(input, { callbacks: [tracer] })` 自动向下传播
- ✅ **重试 + 降级组合使用**：每个模型（主模型和备用模型）都应独立配置重试
- ✅ **降级模型创建的容错处理**：API Key 未配置等错误应被静默跳过，不影响主链
- ✅ **追踪日志使用 `debug` 级别**：避免生产环境日志爆炸，摘要使用 `log` 级别
- ✅ **Map 是计算缓冲区，不是存储层**：持久化由 Winston 日志承担，追踪层不引入额外 I/O
- ✅ **perCallMs 由工厂统一注入**：调用方无需关心超时配置，工厂读取 `ai.timeout.perCallMs` 作为默认值
- ✅ **toolCallingLoopMs 设为 0 可禁用**：当 `maxIterations` + `perCallMs` 已经提供足够保护时，可关闭聚合超时
- ✅ **超时守卫 cleanup 在 finally 中调用**：确保 `clearTimeout` 执行，防止定时器泄漏
- ❌ **避免全局单例 Tracer**：会导致不同请求的 Span 混在一起
- ❌ **避免过多重试**：LLM 调用成本高，3 次（1+2 重试）通常足够
- ❌ **避免在流式中依赖 fallback 的完整性**：流开始后的错误不触发降级
- ❌ **避免降级链与主链使用相同的 API Key**：可能遭遇相同的限流策略
- ❌ **避免将 toolCallingLoopMs 用于长时运行智能体**：该参数仅适用于同步 HTTP 请求内的循环，异步智能体应有独立的超时策略

## 5. 行动导向 (Action Guide)

### Step 1: 创建可观测性层 (`src/ai/observability/`)

**这一步在干什么**：实现 `LangChainTracer`（`BaseCallbackHandler` 子类），负责拦截 LLM / Chain / Tool / Retriever 各环节的生命周期事件并记录结构化指标。

#### 5.1.1 追踪数据结构 (`trace.interface.ts`)

```typescript
// TraceSpan: 单个操作的生命周期记录
export interface TraceSpan {
  runId: string;
  parentRunId?: string;
  name: string;
  type: 'llm' | 'chain' | 'tool' | 'retriever';
  startTime: number;
  endTime?: number;
  latencyMs?: number;
  tokenUsage?: { input: number; output: number; total: number };
  error?: string;
  metadata?: Record<string, unknown>;
}

// TraceSummary: 单次请求的聚合指标
export interface TraceSummary {
  traceId: string;
  totalLatencyMs: number;
  llmCallCount: number;
  llmTotalLatencyMs: number;
  totalTokenUsage: { input: number; output: number; total: number };
  toolCallCount: number;
  retrieverCallCount: number;
  hasError: boolean;
  firstError?: string;
  spans: TraceSpan[];
}
```

#### 5.1.2 LangChain 追踪回调 (`langchain-tracer.ts`)

```typescript
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { Logger } from '@nestjs/common';

export class LangChainTracer extends BaseCallbackHandler {
  name = 'LangChainTracer';
  private readonly spans = new Map<string, TraceSpan>();

  constructor(logger: Logger, traceId?: string) {
    super();
    // 每次请求生成唯一 traceId
  }

  // 拦截 LLM/Chain/Tool/Retriever 的 start/end/error
  handleLLMStart(...) { this.startSpan(runId, parentRunId, name, 'llm'); }
  handleLLMEnd(...)   { this.endSpan(runId); /* 提取 token 用量 */ }
  handleLLMError(...) { this.endSpan(runId, error.message); }
  // ...其余 handle* 方法结构相同

  // 聚合摘要并输出日志
  logSummary(): TraceSummary { ... }
}
```

### Step 2: 创建韧性层 (`src/ai/resilience/`)

**这一步在干什么**：将 LangChain 的 `.withRetry()` 和 `.withFallbacks()` 封装为 NestJS 可注入的 `ResilienceService`，提供声明式的韧性包装能力。

#### 5.2.1 韧性配置 (`resilience.config.ts`)

```typescript
export interface RetryPolicy {
  maxAttempts: number; // 最大重试次数（不含首次）
}

export interface FallbackConfig {
  provider: string;  // 备用提供商
  model?: string;    // 备用模型（可选）
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 2 };
```

#### 5.2.2 韧性服务 (`resilience.service.ts`)

```typescript
@Injectable()
export class ResilienceService {
  constructor(private readonly modelFactory: AiModelFactory) {}

  // 叠加重试
  withRetry<I, O>(runnable: Runnable<I, O>, policy?: RetryPolicy): Runnable<I, O> {
    return runnable.withRetry({
      stopAfterAttempt: policy.maxAttempts + 1,
      onFailedAttempt: (error, attempt) => { /* 记录重试日志 */ },
    });
  }

  // 叠加降级
  withFallbacks<I, O>(primary: Runnable<I, O>, fallbacks: Runnable<I, O>[]): Runnable<I, O> {
    return primary.withFallbacks({ fallbacks });
  }

  // 创建降级模型实例（容错：API Key 缺失时跳过而非抛错）
  createFallbackModels(configs: FallbackConfig[]): BaseChatModel[] { ... }
}
```

### Step 3: 集成到 LCEL 管道

**这一步在干什么**：在 `LcelService` 中新增 `resilientChat` / `streamResilientChat` 方法，将追踪和韧性集成到完整请求链路中。

```typescript
// LcelService 中的 046 扩展
async resilientChat(dto: ResilientChatRequestDto): Promise<ResilientChatResponseDto> {
  // 1. 创建 per-request Tracer
  const tracer = new LangChainTracer(this.logger);

  // 2. 构建标准 LCEL 管道
  const model = this.modelFactory.createChatModel(dto.provider, { ... });
  const { chain, input } = this.chainBuilder.buildChatChain(model, dto.messages);

  // 3. 叠加韧性策略
  let resilientChain = chain;
  if (dto.enableRetry !== false) {
    resilientChain = this.resilienceService.withRetry(resilientChain, {
      maxAttempts: dto.maxRetryAttempts ?? 2,
    });
  }
  if (dto.fallbacks?.length) {
    // 为每个降级模型构建 prompt → model 管道，各自带重试
    const fallbackChains = this.buildFallbackChains(dto);
    resilientChain = this.resilienceService.withFallbacks(resilientChain, fallbackChains);
  }

  // 4. 以 callbacks 方式注入 Tracer，自动传播
  const result = await resilientChain.invoke(input, { callbacks: [tracer] });

  // 5. 返回结果 + 追踪摘要
  const summary = tracer.logSummary();
  return { content: ..., trace: { traceId, totalLatencyMs, ... } };
}
```

### Step 4: 注册到 AiModule

**这一步在干什么**：将 `ResilienceService` 注册为 NestJS Provider（`LangChainTracer` 为普通类，不需要 DI 注册）。

```typescript
// ai.module.ts
import { ResilienceService } from './resilience';

@Module({
  providers: [
    // ...existing providers
    ResilienceService,
  ],
  exports: [
    // ...existing exports
    ResilienceService,
  ],
})
export class AiModule {}
```

### Step 5: API 端点

**这一步在干什么**：在 `LcelController` 中暴露韧性对话端点。

| 端点                                    | 方法                    | 说明                           |
| --------------------------------------- | ----------------------- | ------------------------------ |
| `POST /ai/lcel/resilient/chat`        | `resilientChat`       | 韧性对话（非流式），带追踪摘要 |
| `POST /ai/lcel/resilient/chat/stream` | `streamResilientChat` | 韧性对话（流式），带追踪回调   |

请求示例（启用重试 + 降级）：

```json
{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "messages": [{ "role": "user", "content": "什么是 NestJS？" }],
  "enableRetry": true,
  "maxRetryAttempts": 2,
  "fallbacks": [
    { "provider": "siliconflow", "model": "Pro/MiniMaxAI/MiniMax-M2.5" }
  ]
}
```

响应示例：

```json
{
  "content": "NestJS 是一个用于构建高效、可扩展的 Node.js 服务端应用的框架...",
  "usage": { "promptTokens": 12, "completionTokens": 156, "totalTokens": 168 },
  "finishReason": "stop",
  "trace": {
    "traceId": "trace_1710...",
    "totalLatencyMs": 1523,
    "llmCallCount": 1,
    "llmTotalLatencyMs": 1200,
    "totalTokens": 168
  }
}
```

### Step 6: 超时配置 (`ai.config.ts`)

**这一步在干什么**：在 AI 配置中心新增超时配置段，为双层超时提供统一的默认值和环境变量覆盖入口。

```typescript
// src/common/configs/config/ai.config.ts
export default registerAs('ai', () => ({
  // ...其他配置...

  timeout: {
    // 单次 LLM API 调用的 HTTP 超时（毫秒），作用于 Axios 请求层
    perCallMs: parseInt(process.env.AI_TIMEOUT_PER_CALL || '60000', 10),
    // 同步工具调用循环的总超时（毫秒），保护 HTTP 请求不被无限占用。
    // 仅作用于 ToolCallingLoop（同步 HTTP 请求内的工具调用循环），
    // 不适用于未来 LangGraph 的异步长时运行智能体。
    // 设为 0 表示不限制（依赖 perCallMs + maxIterations 提供保护）。
    toolCallingLoopMs: parseInt(
      process.env.AI_TIMEOUT_TOOL_CALLING_LOOP || '300000', 10,
    ),
  },
}));
```

对应的环境变量（`.env` 可选覆盖）：

```bash
# AI_TIMEOUT_PER_CALL=60000           # 单次 LLM 调用超时（毫秒），默认 60s
# AI_TIMEOUT_TOOL_CALLING_LOOP=300000 # 同步工具调用循环总超时（毫秒），默认 300s，设为 0 不限制
```

### Step 7: Per-Call 超时注入 (工厂层 + 适配器层)

**这一步在干什么**：在模型创建链路中透传 `timeout` 参数，使每次 LLM HTTP 请求都受超时保护。修改涉及三个文件，遵循 Factory → Interface → Adapter 的分层传递。

#### 7.1 适配器接口 (`provider-adapter.interface.ts`)

```typescript
export interface AdapterModelParams {
  apiKey: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  streaming?: boolean;
  maxTokens?: number;
  modelKwargs?: Record<string, unknown>;
  /** 单次 HTTP 请求超时（毫秒），传递给底层 HTTP 客户端（如 Axios） */
  timeout?: number;
}
```

#### 7.2 工厂层 (`model.factory.ts`)

```typescript
export interface CreateModelOptions {
  model?: string;
  temperature?: number;
  streaming?: boolean;
  maxTokens?: number;
  modelKwargs?: Record<string, unknown>;
  /** 单次 HTTP 请求超时（毫秒），未指定时使用 ai.timeout.perCallMs 全局默认值 */
  timeout?: number;
}

// createChatModel 内部：
const timeout =
  options.timeout ?? this.configService.get<number>('ai.timeout.perCallMs');

return entry.adapter.createModel({
  apiKey, model, baseUrl,
  temperature: options.temperature,
  streaming: options.streaming,
  maxTokens: options.maxTokens,
  modelKwargs: options.modelKwargs,
  timeout, // 透传给 Adapter
});
```

#### 7.3 适配器实现 (`openai-compatible.adapter.ts`)

```typescript
export class OpenAICompatibleAdapter implements IProviderAdapter {
  createModel(params: AdapterModelParams): BaseChatModel {
    return new ChatDeepSeek({
      apiKey: params.apiKey,
      model: params.model,
      temperature: params.temperature,
      streaming: params.streaming,
      maxTokens: params.maxTokens,
      // ChatDeepSeek 的 timeout 类型继承自 OpenAI SDK 的 ClientOptions，
      // 其内部类型解析为 error 类型，属于第三方类型缺陷，需 eslint-disable
      ...(params.timeout != null ? { timeout: params.timeout } : {}),
      ...(params.modelKwargs ? { modelKwargs: params.modelKwargs } : {}),
      ...(params.baseUrl ? { configuration: { baseURL: params.baseUrl } } : {}),
    });
  }
}
```

### Step 8: Loop-Level 超时 + 异常过滤 (ToolCallingLoop + AiExceptionFilter)

**这一步在干什么**：在 ToolCallingLoop 中通过 AbortController 实现聚合超时，在 AiExceptionFilter 中统一捕获超时异常并映射为 504。

#### 8.1 ToolCallingLoop 超时守卫

`execute()` 和 `streamExecute()` 新增 `timeoutMs` 参数，内部通过 `createTimeoutGuard` 创建 AbortController：

```typescript
// ToolCallingLoop 核心超时逻辑

// 超时守卫工厂
private createTimeoutGuard(timeoutMs?: number): {
  signal: AbortSignal | undefined;
  cleanup: () => void;
} {
  const resolvedTimeout =
    timeoutMs ?? this.configService.get<number>('ai.timeout.toolCallingLoopMs');

  if (!resolvedTimeout || resolvedTimeout <= 0) {
    return { signal: undefined, cleanup: () => {} };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolvedTimeout);

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

// execute/streamExecute 中的使用模式
async execute(params: { ...; timeoutMs?: number }) {
  const { signal, cleanup } = this.createTimeoutGuard(params.timeoutMs);
  try {
    for (let i = 0; i < maxIterations; i++) {
      // signal 传递给每次 LLM 调用
      const response = await modelWithTools.invoke(messages, { signal });
      // ...
    }
  } catch (error) {
    throw this.handleLoopError(error, startTime, rounds.length, params.timeoutMs);
  } finally {
    cleanup(); // 确保定时器被清理
  }
}

// 统一的错误包装
private handleLoopError(
  error: unknown,
  startTime: number,
  completedRounds: number,
  timeoutMs?: number,
): Error {
  if (error instanceof Error && error.name === 'AbortError') {
    const elapsed = Date.now() - startTime;
    const limit =
      timeoutMs ??
      this.configService.get<number>('ai.timeout.toolCallingLoopMs') ?? 0;
    return new Error(
      `工具调用循环超时: 已执行 ${elapsed}ms (限制 ${limit}ms), ` +
        `完成 ${completedRounds} 轮工具调用后中止`,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}
```

#### 8.2 AiExceptionFilter 超时检测

在异常过滤器中新增超时错误的优先检测，先于通用 LangChain 错误处理：

```typescript
// ai-exception.filter.ts

// catch() 方法中，HttpException 处理之后、通用错误处理之前
if (this.isTimeoutError(exception)) {
  const message = this.extractMessage(exception);
  response.status(HttpStatus.GATEWAY_TIMEOUT).json({
    statusCode: HttpStatus.GATEWAY_TIMEOUT,
    timestamp: new Date().toISOString(),
    path: request.url,
    error: 'ai_timeout',
    message,
  });
  return;
}

// 超时判定：覆盖三种来源
private isTimeoutError(exception: unknown): boolean {
  if (!(exception instanceof Error)) return false;
  if (exception.name === 'AbortError') return true;

  const msg = exception.message.toLowerCase();
  if (msg.includes('timeout') || msg.includes('超时')) return true;

  const code = (exception as unknown as Record<string, unknown>).code;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return true;

  return false;
}
```
