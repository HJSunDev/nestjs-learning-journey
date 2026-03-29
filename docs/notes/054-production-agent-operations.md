# 054. 生产级 Agent 运维与治理 (Production Agent Operations)

## 1. 核心问题与概念 (The "Why")

### 解决什么问题

智能体从 demo 走向生产环境，面临的挑战不是功能缺失，而是运维治理能力的系统性缺位：


| 生产风险        | 表现                                | 后果                                 |
| ----------- | --------------------------------- | ---------------------------------- |
| **提供商故障雪崩** | 一个 LLM API 持续 503，重试请求堆积          | 线程池耗尽，整个服务不可用                      |
| **上下文爆炸**   | 长对话 50+ 轮，消息不断累积                  | 超出上下文窗口报错 / Token 成本线性增长 / 模型注意力稀释 |
| **输出安全漏洞**  | Agent 输出包含用户手机号、身份证号              | PII 泄露，违反数据保护法规                    |
| **工具生态封闭**  | 每个工具都要手写适配代码                      | 无法对接 MCP 生态的数百个现成工具                |
| **黑盒运行**    | 不知道 Agent 执行了几次 LLM 调用、花了多少 Token | 成本不可控，故障难定位                        |


本章针对以上五类风险构建完整的生产运维层，在 053 多智能体 Supervisor 基座之上叠加：

1. **Circuit Breaker 熔断器** — per-provider 故障隔离，防止雪崩
2. **Context Compaction 上下文压缩** — 长对话自动裁剪/摘要，控制成本和质量
3. **Output Guardrail 输出守卫** — PII 脱敏 + 内容安全检测，与输入守卫形成双向防护
4. **MCP 工具标准化** — `@langchain/mcp-adapters` 集成，对接开放工具生态
5. **Agent Metrics 评估指标** — 请求级全链路运维指标收集

### 核心概念与依赖


| 概念                           | 技术实现                                                   | 角色                                     |
| ---------------------------- | ------------------------------------------------------ | -------------------------------------- |
| Circuit Breaker              | `cockatiel` 库的 `circuitBreaker` + `ConsecutiveBreaker` | 连续失败计数 → 熔断 → 半开探测 → 恢复                |
| Context Compaction           | `@langchain/core` 的 `trimMessages` + LLM 摘要节点          | 消息裁剪 / 旧消息压缩为摘要                        |
| Output Guardrail             | 正则 PII 检测 + 内容安全模式匹配                                   | 脱敏替换 / 硬拦截                             |
| MCP (Model Context Protocol) | `@langchain/mcp-adapters` 的 `MultiServerMCPClient`     | 将 MCP 服务器工具转为 LangChain StructuredTool |
| Agent Metrics                | 自建 `AgentMetricsCollector` (per-request 实例)            | 四维指标：性能/成本/质量/韧性                       |


### 新增依赖

```bash
npm install cockatiel @langchain/mcp-adapters
```

- **cockatiel** (v3.x) — 零依赖的 TypeScript 韧性库，提供 Circuit Breaker / Retry / Timeout / Bulkhead 策略。灵感来自 .NET 的 Polly。
- **@langchain/mcp-adapters** — LangChain 官方 MCP 适配器，将 MCP 服务器工具包装为 `DynamicStructuredTool`。

---

## 2. 核心用法 / 方案设计 (Usage / Design)

### 架构总览：运维流水线

```
Request
  │
  ▼
┌─────────────────┐
│  Input Guardrail│  ← 048 已有：Prompt Injection + 消息限制
└────────┬────────┘
         │
         ▼
┌─────────────────────┐
│  Context Compaction │  ← 054 新增：长对话裁剪/摘要
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Circuit Breaker    │  ← 054 新增：per-provider 熔断保护
│  ┌─────────────────┐│
│  │  Supervisor App ││
│  │ (053 Multi-Agent││
│  │   + Tools/MCP)  ││
│  └─────────────────┘│
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Output Guardrail   │  ← 054 新增：PII 脱敏 + 内容安全
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  Metrics Collector  │  ← 054 新增：全链路指标报告
└────────┬────────────┘
         │
         ▼
Response (含 metrics 报告)
```

### 场景 A: Circuit Breaker — 提供商故障隔离

**问题**：当 deepseek API 持续返回 503 时，重试只是在浪费时间和资源。

**解决方案**：per-provider 熔断器，连续失败 N 次后快速失败，等待恢复。

```typescript
// cockatiel 的三态模型
// CLOSED → 正常通行，失败计数
// OPEN   → 快速失败，不发送请求
// HALF_OPEN → 允许一个探测请求，成功则关闭，失败则重新打开

import { circuitBreaker, ConsecutiveBreaker, handleAll } from 'cockatiel';

const breaker = circuitBreaker(handleAll, {
  halfOpenAfter: 30_000,  // 30 秒后尝试恢复
  breaker: new ConsecutiveBreaker(5),  // 连续 5 次失败触发
});

// 在熔断器保护下执行 LLM 调用
const result = await breaker.execute(() => model.invoke(messages));
```

**项目实现**：`CircuitBreakerRegistry` 为每个 provider 懒创建独立的熔断器实例。

### 场景 B: Context Compaction — 长对话自动压缩

**问题**：50 轮对话后消息累积到 25k tokens，超出上下文窗口或导致模型注意力稀释。

**两种策略**：

1. **trim（裁剪）**：保留 SystemMessage + 最近 N 条消息，零 LLM 调用，延迟 <1ms
2. **summarize（摘要+裁剪）**：将旧消息压缩为摘要 SystemMessage，保留语义连续性

```typescript
// 压缩服务自动处理 ToolMessage 配对完整性
const result = await compactionService.compact(messages, {
  strategy: 'trim',      // 或 'summarize'
  maxMessages: 30,        // 超过 30 条触发
  preserveRecent: 10,     // 摘要模式保留最近 10 条
});

if (result.compacted) {
  console.log(`压缩: ${result.originalCount} → ${result.compactedCount} 条`);
}
```

### 场景 C: Output Guardrail — 双向安全防护

**问题**：输入守卫只防攻击者，输出守卫防 Agent 自身（PII 泄露、系统提示词泄露）。

```typescript
import { validateOutput } from '../shared/guards';

const result = validateOutput(agentOutput, {
  enablePiiSanitization: true,   // PII 脱敏
  enableSafetyCheck: true,       // 内容安全
});

if (!result.passed) {
  // 硬拦截：替换为安全消息
  return '抱歉，响应内容触发了安全策略。';
}
if (result.sanitizedContent) {
  // 软处理：PII 已被掩码替换
  return result.sanitizedContent;
}
```

**检测规则**：


| 类别              | 模式                       | 处理方式             |
| --------------- | ------------------------ | ---------------- |
| PII: 手机号        | `1[3-9]\d{9}`            | 替换为 `***手机号*`**  |
| PII: 身份证号       | `\d{17}[\dXx]`           | 替换为 `***身份证号***` |
| PII: 邮箱         | `[a-zA-Z0-9._%+-]+@...`  | 替换为 `***邮箱***`   |
| Safety: 系统提示词泄露 | `my system prompt is...` | 硬拦截              |
| Safety: 危险命令    | `rm -rf /`, `DROP TABLE` | 硬拦截              |


### 场景 D: MCP 工具标准化 — 对接开放工具生态

**问题**：每个外部工具都要手写 `DynamicStructuredTool` 适配代码。

**解决方案**：通过 MCP 协议标准化，`@langchain/mcp-adapters` 自动将 MCP 服务器工具转为 LangChain 工具。

```typescript
// 环境变量配置 MCP 服务器
// AI_MCP_ENABLED=true
// AI_MCP_SERVERS={"weather":{"transport":"http","url":"http://localhost:3001/mcp"}}

// McpToolAdapter 在模块初始化时自动：
// 1. 连接 MCP 服务器
// 2. 获取工具列表
// 3. 注册到 ToolRegistry
// Agent 使用 MCP 工具与使用内置工具完全一致

// 也支持运行时动态加载
const toolNames = await mcpAdapter.loadServer({
  name: 'database',
  transport: 'http',
  url: 'http://localhost:3002/mcp',
});
```

### 场景 E: Agent Metrics — 全链路运维指标

**问题**：Agent 执行是黑盒，不知道调用了几次 LLM、花了多少 Token、是否触发了重试。

**解决方案**：`AgentMetricsCollector` 在每次请求生命周期内收集四维指标：

```typescript
const collector = new AgentMetricsCollector('deepseek', 'deepseek-chat');

// 自动从 LangChainTracer 导入 LLM/Tool 调用指标
collector.importFromTraceSummary(tracer.getSummary());

// 记录运维事件
collector.recordCompaction(50, 20);
collector.recordGuardrailTrigger(['pii:phone_cn']);
collector.recordCircuitBreakerState('closed');

// 最终化并写入日志
const report = collector.finalize('success');
// report.totalLatencyMs, report.tokenUsage, report.status, ...
```

**四维指标体系**：


| 维度  | 指标                                                    | 用途         |
| --- | ----------------------------------------------------- | ---------- |
| 性能  | `totalLatencyMs`, `llmCallCount`, `llmTotalLatencyMs` | 延迟告警、优化方向  |
| 成本  | `tokenUsage.{input,output,total}`                     | 成本核算、预算告警  |
| 质量  | `status`, `guardrailTriggered`, `contextCompacted`    | 质量监控、安全审计  |
| 韧性  | `circuitBreakerState`, `retryCount`, `fallbackUsed`   | 稳定性监控、故障定位 |


---

## 3. 深度原理与机制 (Under the Hood)

### 3.1 Circuit Breaker 状态机

```
     ┌─────────────────────────────────┐
     │                                 │
     ▼                                 │ 探测失败
 ┌────────┐  连续 N 次失败   ┌────────┐ │
 │ CLOSED │ ───────────────►│  OPEN  │─┘
 │ (通行)  │                │(快速失败)│
 └────────┘                 └────┬───┘
     ▲                           │
     │ 探测成功               halfOpenAfter 超时
     │                           │
     │                     ┌────▼────┐
     └──────────────────── │HALF_OPEN│
                           │(允许一个)│
                           └─────────┘
```

**cockatiel ConsecutiveBreaker vs SamplingBreaker**：

- `ConsecutiveBreaker(n)`：连续 n 次失败触发，一次成功即重置计数。适合 LLM API（失败通常是连续的服务中断）。
- `SamplingBreaker`：在采样窗口内失败率超过阈值触发。适合高并发场景的概率性失败。

**Per-Provider 隔离设计**：每个 AI 提供商（deepseek、siliconflow 等）拥有独立的熔断器实例。deepseek 故障不影响 siliconflow 的请求通行。

### 3.2 Context Compaction 机制

**ToolMessage 配对保护**：裁剪时必须确保 ToolMessage 的前置 AIMessage（含 `tool_calls`）存在。
否则模型收到孤立的 ToolMessage 会产生困惑甚至执行异常。

```
✅ 保留完整配对：
  AIMessage(tool_calls: [get_weather]) → ToolMessage(tool_call_id: xxx)

❌ 裁剪后的断链：
  ToolMessage(tool_call_id: xxx)  ← 前置 AIMessage 被裁掉
```

**摘要降级策略**：当 LLM 摘要调用失败时，自动降级为纯裁剪模式。避免摘要服务故障导致主请求失败。

### 3.3 Output Guardrail 分层策略

```
Agent 输出
  │
  ├── 第一层：内容安全检测 (硬拦截)
  │     └── 匹配 → 直接替换为安全消息，不返回原始内容
  │
  └── 第二层：PII 脱敏 (软处理)
        └── 匹配 → 替换掩码后放行（如 13800138000 → ***手机号***）
```

**与输入守卫的对称设计**：


| 维度  | Input Guardrail (048) | Output Guardrail (054) |
| --- | --------------------- | ---------------------- |
| 目标  | 防止恶意输入                | 防止有害输出                 |
| 策略  | Prompt Injection 检测   | PII 脱敏 + 内容安全          |
| 处理  | 不通过 → 拒绝请求 (400)      | 不通过 → 替换内容 / 拦截        |
| 位置  | 流水线入口                 | 流水线出口                  |


### 3.4 MCP 协议集成架构

```
┌──────────────────────────────────────────────┐
│                   NestJS App                 │
│                                              │
│  ┌────────────┐     ┌──────────────────────┐ │
│  │ToolRegistry│ ◄── │   McpToolAdapter     │ │
│  │ (内置工具)  │     │  (OnModuleInit 注册) │ │
│  └────────────┘     └──────────┬───────────┘ │
│         │                      │             │
│         ▼                      ▼             │
│  ┌────────────┐     ┌──────────────────────┐ │
│  │ Agent/Graph│     │ MultiServerMCPClient │ │
│  │ (消费工具)  │     │ (@langchain/mcp-     │ │
│  └────────────┘     │  adapters)           │ │
│                     └──────┬───────────────┘ │
└────────────────────────────┼─────────────────┘
                             │ MCP Protocol
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
         ┌────────┐    ┌────────┐    ┌────────┐
         │MCP Srv │    │MCP Srv │    │MCP Srv │
         │(stdio) │    │ (HTTP) │    │ (HTTP) │
         └────────┘    └────────┘    └────────┘
```

**无缝集成设计**：MCP 工具注册到 `ToolRegistry` 后，对上层 Agent 完全透明。Agent 通过 `toolRegistry.getTools()` 获取工具列表时，内置工具和 MCP 工具混合在一起，无需区分。

### 3.5 可观测性演进路径


| 层级        | 能力                                     | 当前状态       |
| --------- | -------------------------------------- | ---------- |
| L1 日志驱动   | LangChainTracer → Winston JSON 日志      | ✅ 046 已实现  |
| L1.5 运维指标 | AgentMetricsCollector → 结构化日志 + API 返回 | ✅ 054 本章实现 |
| L2 指标聚合   | Prometheus Exporter → Grafana 仪表盘      | 📋 文档指引    |
| L3 分布式追踪  | OpenTelemetry SDK → Jaeger/Zipkin      | 📋 文档指引    |
| L4 LLM 平台 | LangSmith / Langfuse → Prompt 评估与微调    | 📋 文档指引    |


**L2 Prometheus 集成方向**（生产实施时）：

```typescript
// 使用 @willsoto/nestjs-prometheus 包
// 在 AgentMetricsCollector.finalize() 中推送指标到 Prometheus

// 关键 Counter/Histogram：
// agent_requests_total{provider, model, status}      — 请求总数
// agent_latency_seconds{provider, model}              — 延迟直方图
// agent_token_usage_total{provider, model, direction} — Token 消耗
// agent_circuit_breaker_state{provider}               — 熔断器状态
```

---

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

### ✅ 推荐做法

- **熔断器 per-provider 隔离**：每个 AI 提供商独立熔断，避免一个提供商故障影响全局
- **压缩策略按场景选择**：大部分场景 `trim` 即可（零延迟），仅在需要保留历史语义时使用 `summarize`
- **输出守卫分层**：安全检测硬拦截，PII 脱敏软替换，避免误杀正常输出
- **MCP 连接失败静默跳过**：McpToolAdapter 连接失败不阻塞应用启动
- **指标从 Tracer 导入**：避免在 Tracer 和 Collector 中重复收集 LLM/Tool 调用数据
- **韧性组合顺序**：CircuitBreaker(外) → Retry(中) → Fallbacks(内) → 实际调用

### ❌ 避免做法

- **避免全局单一熔断器**：所有 provider 共用一个熔断器，一个故障全部熔断
- **避免盲目 summarize**：摘要需要额外 LLM 调用（500ms+），大部分场景纯裁剪已足够
- **避免裁剪时破坏 ToolMessage 配对**：孤立的 ToolMessage 会导致模型行为异常
- **避免在流式中间做完整输出守卫**：应在流结束时对累积的完整内容做一次检查
- **避免硬编码 PII 规则**：不同业务场景的 PII 定义不同，应支持规则扩展

### 异步长时运行 + Durable 模式选型


| 模式      | 适用场景                  | 配置                                    |
| ------- | --------------------- | ------------------------------------- |
| `sync`  | 常规对话（<30s）、需要强一致性的审批流 | `AI_CHECKPOINT_DURABILITY_MODE=sync`  |
| `async` | 高并发场景、可容忍极低概率丢失最后一步   | `AI_CHECKPOINT_DURABILITY_MODE=async` |
| `exit`  | 开发/测试环境、对持久化要求不高      | `AI_CHECKPOINT_DURABILITY_MODE=exit`  |


生产建议：默认 `sync`，在压测验证吞吐量后再考虑 `async`。

---

## 5. 行动导向 (Action Guide)

### Step 1: 安装依赖

**这一步在干什么**：引入 cockatiel（Circuit Breaker）和 @langchain/mcp-adapters（MCP 工具标准化）两个新依赖。

```bash
npm install cockatiel @langchain/mcp-adapters
```

### Step 2: 配置环境变量

**这一步在干什么**：在 `.env` 中添加 054 章节的配置项。所有配置都有合理默认值，不配置也能工作。

```bash
# --- AI 熔断器 (054 生产级 Agent 运维) ---
# AI_CIRCUIT_BREAKER_THRESHOLD=5              # 连续失败多少次后触发熔断
# AI_CIRCUIT_BREAKER_HALF_OPEN_AFTER=30000    # 熔断后多久（毫秒）尝试恢复

# --- AI 上下文压缩 (054 Context Compaction) ---
# AI_COMPACTION_MAX_MESSAGES=50               # 超过此消息数量触发压缩
# AI_COMPACTION_PRESERVE_RECENT=10            # 摘要模式下保留最近 N 条消息

# --- AI MCP 工具 (054 MCP 工具标准化) ---
# AI_MCP_ENABLED=false                        # 是否启用 MCP 工具加载
# AI_MCP_SERVERS={}                           # MCP 服务器配置 JSON
```

### Step 3: Circuit Breaker 熔断器实现

**这一步在干什么**：在 `src/ai/resilience/` 下创建 `CircuitBreakerRegistry`，为每个 AI 提供商管理独立的熔断器实例。然后扩展现有的 `ResilienceService`，新增 `withCircuitBreaker()` 方法。

**3.1 扩展韧性配置类型** (`resilience.config.ts`)：

```typescript
export interface CircuitBreakerPolicy {
  consecutiveFailures: number;
  halfOpenAfterMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER_POLICY: CircuitBreakerPolicy = {
  consecutiveFailures: 5,
  halfOpenAfterMs: 30_000,
};
```

**3.2 创建熔断器注册表** (`circuit-breaker.registry.ts`)：

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  circuitBreaker,
  ConsecutiveBreaker,
  handleAll,
  type CircuitBreakerPolicy as CockatielCircuitBreaker,
  BrokenCircuitError,
} from 'cockatiel';

@Injectable()
export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CockatielCircuitBreaker>();

  // 懒创建 provider 级熔断器
  async execute<T>(provider: string, fn: () => Promise<T>): Promise<T> {
    const breaker = this.getOrCreate(provider);
    return breaker.execute(fn);
  }

  private getOrCreate(provider: string): CockatielCircuitBreaker {
    let breaker = this.breakers.get(provider);
    if (breaker) return breaker;

    breaker = circuitBreaker(handleAll, {
      halfOpenAfter: this.policy.halfOpenAfterMs,
      breaker: new ConsecutiveBreaker(this.policy.consecutiveFailures),
    });

    // 状态变更监听 — 写入日志
    breaker.onStateChange((state) => {
      this.logger.warn(`熔断器状态变更: ${provider} → ${state}`);
    });

    this.breakers.set(provider, breaker);
    return breaker;
  }
}
```

**3.3 扩展 ResilienceService** — 新增 `withCircuitBreaker()` 方法：

```typescript
async withCircuitBreaker<T>(
  provider: string,
  fn: () => Promise<T>,
): Promise<T> {
  return this.circuitBreakerRegistry.execute(provider, fn);
}
```

### Step 4: Context Compaction 上下文压缩

**这一步在干什么**：在 `src/ai/agents/shared/compaction/` 下创建 `ContextCompactionService`，提供 `compact()` 方法自动压缩长对话。

```typescript
@Injectable()
export class ContextCompactionService {
  async compact(
    messages: BaseMessage[],
    options: CompactionOptions = {},
  ): Promise<CompactionResult> {
    const maxMessages = options.maxMessages ?? this.defaultMaxMessages;

    // 未超限则直接返回
    if (messages.length <= maxMessages) {
      return { messages, compacted: false, ... };
    }

    // 按策略压缩
    return strategy === 'summarize'
      ? await this.summarizeAndTrim(messages, options)
      : this.trimOnly(messages, maxMessages);
  }

  // 关键：确保 ToolMessage 配对完整性
  private ensureToolMessagePairing(messages: BaseMessage[]): BaseMessage[] {
    // 遍历消息，移除缺少前置 AIMessage(tool_calls) 的孤立 ToolMessage
  }
}
```

### Step 5: Output Guardrail 输出守卫

**这一步在干什么**：在 `src/ai/agents/shared/guards/output-guardrail.ts` 创建 `validateOutput()` 函数，与现有的 `validateInput()` 形成双向安全防护。

```typescript
export function validateOutput(
  content: string,
  options: { enablePiiSanitization?: boolean; enableSafetyCheck?: boolean } = {},
): OutputGuardrailResult {
  // 第一层：内容安全检测（硬拦截）
  for (const { name, pattern } of SAFETY_PATTERNS) {
    if (pattern.test(content)) {
      return { passed: false, reason: `安全规则: ${name}`, triggeredRules: [...] };
    }
  }

  // 第二层：PII 脱敏（软处理）
  let sanitized = content;
  for (const { name, pattern, mask } of PII_PATTERNS) {
    if (pattern.test(sanitized)) {
      sanitized = sanitized.replace(pattern, mask);
    }
  }

  return { passed: true, sanitizedContent: sanitized !== content ? sanitized : undefined, triggeredRules };
}
```

### Step 6: Agent Metrics 指标收集器

**这一步在干什么**：在 `src/ai/observability/agent-metrics.collector.ts` 创建 per-request 的指标收集器。

```typescript
export class AgentMetricsCollector {
  // 记录各维度指标
  recordLlmCall(latencyMs, tokenUsage?);
  recordToolCall(latencyMs);
  recordCompaction(before, after);
  recordGuardrailTrigger(rules);
  recordCircuitBreakerState(state);

  // 从 LangChainTracer 批量导入（避免重复收集）
  importFromTraceSummary(summary);

  // 最终化：聚合 → 写入日志 → 返回报告
  finalize(status, error?): AgentMetrics;
}
```

### Step 7: MCP 工具适配器

**这一步在干什么**：在 `src/ai/tools/mcp/mcp-tool.adapter.ts` 创建 `McpToolAdapter`，在模块初始化时自动连接 MCP 服务器、注册工具到 `ToolRegistry`。

```typescript
@Injectable()
export class McpToolAdapter implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    if (!enabled) return;
    // 从环境变量读取 MCP 服务器配置
    this.client = new MultiServerMCPClient(serverConfigs);
    const tools = await this.client.getTools();
    // 注册到 ToolRegistry，对上层 Agent 透明
    for (const tool of tools) {
      this.toolRegistry.register(tool);
    }
  }

  // 运行时动态加载
  async loadServer(config: McpServerConfig): Promise<string[]>;
}
```

### Step 8: OpsService 编排服务

**这一步在干什么**：在 `src/ai/agents/ops/ops.service.ts` 创建 `OpsService`，将所有运维能力编排为完整的流水线。

```typescript
@Injectable()
export class OpsService {
  async invoke(params: OpsInvokeParams): Promise<OpsInvokeResult> {
    // ① 输入守卫
    validateInput(params.messages);

    // ② 上下文压缩
    const compacted = await this.compactionService.compact(messages, {...});

    // ③ 在熔断器保护下执行 Supervisor
    const result = await this.resilienceService.withCircuitBreaker(
      params.provider,
      () => app.invoke({ messages: compacted.messages }, { callbacks: [tracer] }),
    );

    // ④ 输出守卫
    const outputCheck = validateOutput(response.content, {...});

    // ⑤ 指标收集
    const metrics = metricsCollector.finalize('success');

    return { ...response, metrics };
  }
}
```

### Step 9: Controller 端点注册

**这一步在干什么**：在 `AgentController` 中注册 054 章节的 HTTP 端点。

```
POST /ai/agent/ops/chat                     — 生产级运维对话
POST /ai/agent/ops/chat/stream              — 生产级运维流式对话
GET  /ai/agent/ops/circuit-breakers         — 查询熔断器状态
POST /ai/agent/ops/circuit-breakers/:provider/reset — 重置熔断器
```

### Step 10: Module 注册

**这一步在干什么**：在 `AiModule` 中注册新增的 Provider。

```typescript
providers: [
  // ...existing providers...
  OpsService,
  CircuitBreakerRegistry,
  ContextCompactionService,
  McpToolAdapter,
],
```

### Step 11: 验证

**非流式调用**（Apifox / APIpost / curl）：

```json
POST /ai/agent/ops/chat
{
  "provider": "siliconflow",
  "model": "Pro/MiniMaxAI/MiniMax-M2.5",
  "messages": [
    { "role": "user", "content": "查一下北京天气，再算算温度变化" }
  ],
  "enableCircuitBreaker": true,
  "enableCompaction": true,
  "enableOutputGuardrail": true
}
```

**查询熔断器状态**：

```
GET /ai/agent/ops/circuit-breakers
```

**响应中的 metrics 字段包含完整的运维指标报告**。

---

## 6. 文件布局

```
src/ai/
├── resilience/
│   ├── resilience.config.ts          ← 扩展：新增 CircuitBreakerPolicy
│   ├── resilience.service.ts         ← 扩展：新增 withCircuitBreaker()
│   ├── circuit-breaker.registry.ts   ← 054 新增：per-provider 熔断器注册表
│   └── index.ts
├── agents/
│   ├── ops/
│   │   ├── ops.service.ts            ← 054 新增：运维编排服务
│   │   ├── ops.types.ts              ← 054 新增：运维层类型
│   │   └── index.ts
│   ├── shared/
│   │   ├── compaction/
│   │   │   ├── context-compaction.service.ts  ← 054 新增：上下文压缩
│   │   │   └── index.ts
│   │   └── guards/
│   │       ├── input-guardrail.ts    ← 现有（048）
│   │       ├── output-guardrail.ts   ← 054 新增：输出守卫
│   │       └── index.ts
│   └── agent.controller.ts          ← 扩展：新增 054 端点
├── observability/
│   ├── langchain-tracer.ts           ← 现有（046）
│   ├── trace.interface.ts            ← 扩展：新增 AgentMetrics 类型
│   ├── agent-metrics.collector.ts    ← 054 新增：运维指标收集器
│   └── index.ts
├── tools/
│   ├── mcp/
│   │   ├── mcp-tool.adapter.ts       ← 054 新增：MCP 工具适配器
│   │   └── index.ts
│   └── tool.registry.ts             ← 现有（043）
├── dto/
│   └── ops-chat.dto.ts              ← 054 新增：运维对话 DTO
└── ai.module.ts                     ← 扩展：注册新 Provider
```

