# AI 模块经验 (ai)

---

### [EXP-001] @langchain/openai (ChatOpenAI) 会静默丢弃所有模型的 reasoning_content 推理字段

- **日期**: 2026-02-09
- **关联**: `src/ai/factories/model.factory.ts`, `src/ai/normalizers/reasoning.normalizer.ts`
- **标签**: `#langchain` `#reasoning` `#ChatOpenAI` `#模型选型`

#### 问题现象
通过 `@langchain/openai` 的 `ChatOpenAI` 类调用任何支持推理的模型（包括 OpenAI 自家的 o1/o3 系列、xAI Grok，以及通过 baseURL 接入的 DeepSeek、Qwen、Moonshot、GLM 等），返回的 `reasoning_content` 推理内容均被静默丢弃，`AIMessage.additional_kwargs` 中无该字段，且不会抛出任何错误。

#### 根因分析
`@langchain/openai` 的 `ChatOpenAI` 内部将 API 原始响应转换为 LangChain `AIMessage` 时，消息转换函数使用白名单机制复制字段到 `additional_kwargs`，白名单中只有 `function_call`、`audio` 等，**未包含 `reasoning_content`**。这是该包自身的设计遗漏，影响所有通过该类调用的模型。此外，构造函数中存在运算符优先级 bug，导致用户传入的 `reasoning` 配置项被静默覆盖为 `{ effort: undefined }` (GitHub Issue [#9663](https://github.com/langchain-ai/langchainjs/issues/9663))。

截至 2026-02-09，`@langchain/openai` npm 包尚无明确的合并修复。

#### 验证方案 ✅
使用 `@langchain/deepseek` 的 `ChatDeepSeek` 类，它重写了基类的 `_convertCompletionsMessageToBaseMessage()` 和 `_convertCompletionsDeltaToBaseMessageChunk()` 方法，绕开了 ChatOpenAI 的白名单机制，正确保留 `reasoning_content`（官方文档示例已验证 `additional_kwargs.reasoning_content` 可正常获取）。

⚠️ **勘误 (2026-03-05)**：原文列出的 `@langchain/community` 厂商专用类（ChatMoonshot、ChatAlibabaTongyi、ChatZhipuAI）**未经实际源码验证**，系基于"各自实现了响应解析"的推断。后续源码审计发现 `ChatMoonshot` 不支持 `reasoning_content`（详见 EXP-002）。实际验证通过的仅有 `ChatDeepSeek`。

当前推荐方案（详见 EXP-003）：
- DeepSeek / Moonshot / Qwen / GLM → 统一使用 `ChatDeepSeek`（通过 `configuration.baseURL` 切换厂商）
- OpenAI o1/o3 → 推理文本不暴露于 Chat Completions API，需等待 Responses API 的 LangChain 适配

#### 反模式 ❌
```typescript
// ❌ 用 ChatOpenAI 调用任何推理模型（无论是 OpenAI 自家还是第三方）
import { ChatOpenAI } from '@langchain/openai';
const model = new ChatOpenAI({
  model: 'deepseek-reasoner', // 或 'o1', 'grok-3-mini' 等
  configuration: { baseURL: 'https://api.deepseek.com/v1' },
});
// reasoning_content 被静默丢弃，无错误提示
```
失败原因：ChatOpenAI 的白名单转换机制是包级别的缺陷，与调用哪家模型无关。

#### 适用条件
- `@langchain/openai` npm 包所有当前版本（≤0.6.16，截至 2026-02-09 未修复）
- 适用于所有通过 `reasoning_content` 字段返回推理内容的模型
- 若未来 LangChain JS 合并对应修复，此问题可能解决，届时标记 `[DEPRECATED]`

---

### [EXP-002] @langchain/community 的 ChatMoonshot 不支持 reasoning_content、tool calling 和真正的流式输出

- **日期**: 2026-03-05
- **关联**: `src/ai/factories/model.factory.ts`
- **标签**: `#langchain` `#reasoning` `#ChatMoonshot` `#community` `#模型选型`

#### 问题现象
`@langchain/community@1.1.22` 的 `ChatMoonshot` 类无法获取推理内容、不支持工具调用、流式输出名不副实。

#### 根因分析
对 `@langchain/community@1.1.22`（npm 最新版）的 `ChatMoonshot` 源码 (`libs/langchain-community/src/chat_models/moonshot.ts`) 进行了逐行审计，发现以下问题：

1. **reasoning_content 丢失**：`_generate()` 返回 `new AIMessage(text)` — 仅传入纯文本，`additional_kwargs` 为空对象，API 响应中的 `reasoning_content` 被完全丢弃。
2. **响应类型定义不完整**：内部 `ChoiceMessage` 接口只有 `{ role: string; content: string }`，从类型层面就排除了 `reasoning_content` 和 `tool_calls`。
3. **不支持 tool calling**：`messageToRole()` 遇到 function/tool 类型消息直接 `throw new Error`。
4. **流式实现不完整**：未实现 `_streamResponseChunks()` 方法。其"流式"是在 `_generate()` 内部收集所有 SSE chunk 后拼接成完整响应一次性返回，`model.stream()` 无法逐块输出。
5. **模型列表过时**：类型定义仅包含 `moonshot-v1-8k/32k/128k`，缺少 `kimi-k2` 等新模型。

此外，`@langchain/community` 存在依赖冲突：`@browserbasehq/stagehand@^1.0.0` 被声明为 **required** peer dependency（未标记 optional），而 `stagehand@^1.x` 要求 `dotenv@^16`，与项目的 `dotenv@^17` 冲突，导致 `npm install` 失败。

#### 验证方案 ✅
不使用 `ChatMoonshot`。改用 `ChatDeepSeek`（`@langchain/deepseek`）通过 `configuration.baseURL` 指向 Moonshot API（详见 EXP-003）。

#### 反模式 ❌
```typescript
// ❌ 使用 @langchain/community 的 ChatMoonshot
import { ChatMoonshot } from '@langchain/community/chat_models/moonshot';
const model = new ChatMoonshot({ model: 'kimi-k2', apiKey: '...' });
const result = await model.invoke([...]);
// reasoning_content 被丢弃，tool_calls 不支持，stream() 不逐块输出
```

#### 适用条件
- `@langchain/community` npm 包 ≤1.1.22（截至 2026-03-05）
- 若 LangChain 社区重写 ChatMoonshot 实现，此问题可能解决，届时标记 `[DEPRECATED]`

---

### [EXP-003] 使用 ChatDeepSeek 统一适配所有 OpenAI 兼容的国内模型厂商

- **日期**: 2026-03-05
- **关联**: `src/ai/factories/model.factory.ts`, `src/ai/normalizers/reasoning.normalizer.ts`
- **标签**: `#langchain` `#reasoning` `#ChatDeepSeek` `#多厂商适配` `#架构决策`

#### 问题现象
需要统一接入 DeepSeek、Moonshot、Qwen、GLM 四家国内模型厂商，且需保留 `reasoning_content` 推理字段、支持 tool calling 和真正的流式输出。`@langchain/openai` 的 ChatOpenAI 丢弃推理字段（EXP-001），`@langchain/community` 的厂商专用类实现质量参差不齐（EXP-002），无法满足需求。

#### 根因分析
四家国内厂商的 API 均遵循 **OpenAI Chat Completions 兼容格式**，且 `reasoning_content` 字段位置完全一致（`choice.message.reasoning_content` / `choice.delta.reasoning_content`，与 `content` 同级）。`@langchain/deepseek` 的 `ChatDeepSeek` 重写了基类的响应转换方法，通过 `(message as any).reasoning_content` 从原始响应中提取该字段，不依赖任何 DeepSeek 特有的 API 行为。因此只需修改 `configuration.baseURL` 即可指向其他厂商。

各厂商 API 兼容性验证（2026-03-05）：

| 厂商 | API 端点 | reasoning_content 位置 | 启用方式 | ChatDeepSeek 兼容 |
|------|---------|----------------------|---------|:-:|
| DeepSeek | `https://api.deepseek.com` | `message/delta.reasoning_content` | 使用推理模型 | ✅ 原生 |
| Moonshot | `https://api.moonshot.cn/v1` | `message/delta.reasoning_content` | 使用推理模型 (kimi-k2) | ✅ |
| Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `message/delta.reasoning_content` | `enable_thinking: true` | ✅ |
| GLM | `https://open.bigmodel.cn/api/paas/v4` | `message/delta.reasoning_content` | `thinking: {type:"enabled"}` | ✅ |
| OpenAI | — | 推理文本不暴露 | — | ❌ 机制不同 |

#### 验证方案 ✅
在 `AiModelFactory` 中，所有国内厂商统一使用 `ChatDeepSeek`，通过 `configuration.baseURL` 和 `apiKey` 区分：

```typescript
import { ChatDeepSeek } from '@langchain/deepseek';

// Moonshot
new ChatDeepSeek({
  apiKey: moonshotApiKey,
  model: 'kimi-k2',
  configuration: { baseURL: 'https://api.moonshot.cn/v1' },
});

// Qwen（需通过 modelKwargs 传入 enable_thinking）
new ChatDeepSeek({
  apiKey: qwenApiKey,
  model: 'qwen-plus',
  configuration: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  modelKwargs: { enable_thinking: true },
});

// GLM（需通过 modelKwargs 传入 thinking 配置）
new ChatDeepSeek({
  apiKey: glmApiKey,
  model: 'glm-5',
  configuration: { baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
  modelKwargs: { thinking: { type: 'enabled' } },
});
```

依赖链干净：`@langchain/deepseek`（peer dep: `@langchain/core@^1.0.0`，direct dep: `@langchain/openai@1.2.12`），不涉及 `@langchain/community`，无 dotenv 冲突。

#### 反模式 ❌
```typescript
// ❌ 为每个厂商使用不同的 LangChain 集成类
import { ChatMoonshot } from '@langchain/community/chat_models/moonshot';
import { ChatAlibabaTongyi } from '@langchain/community/chat_models/alibaba_tongyi';
// 1. 实现质量参差不齐，部分类不支持 reasoning_content
// 2. @langchain/community 存在 peer dependency 冲突
// 3. 增加维护成本，每个类的行为差异需要逐一处理
```

#### 适用条件
- 所有使用 OpenAI Chat Completions 兼容格式且通过 `reasoning_content` 字段返回推理内容的厂商
- `@langchain/deepseek` ≥1.0.16
- OpenAI o1/o3 不适用（推理文本不暴露于 Chat Completions API）
- Qwen 和 GLM 的推理功能需通过 `modelKwargs` 传入厂商特定参数
- 若某厂商的 `reasoning_content` 字段位置发生变化，需重新验证

---

### [EXP-004] 避免引入 @langchain/community：peer dependency 冲突与自实现策略

- **日期**: 2026-03-13
- **关联**: `package.json`, `src/ai/rag/`, `src/ai/memory/redis-chat-history.ts`
- **标签**: `#langchain` `#community` `#peer-dependency` `#自实现` `#架构决策`

#### 问题现象
多次尝试安装 `@langchain/community` 均失败，报 `ERESOLVE unable to resolve dependency tree`。即使成功装入 `package.json`，后续任何 `npm install` 也会因冲突而失败。

#### 根因分析
`@langchain/community` 是 LangChain 的集成聚合包，声明了 100+ 个 peer dependencies。其中 `@browserbasehq/stagehand`（浏览器自动化包）引发多层冲突：

```
@langchain/community
  └─ peer: @browserbasehq/stagehand@^1.0.0
       ├─ peer: dotenv@^16.4.5      ← 与项目 dotenv@^17.x 冲突
       └─ peer: openai@^4.62.1      ← 与项目 openai@6.x 冲突
```

尝试过的修复路径均不理想：
- `.npmrc` + `legacy-peer-deps=true`：关闭**所有**包的 peer dep 校验，过于粗暴
- `package.json` `overrides`：修复一个冲突（dotenv）后又冒出下一个（openai），打地鼠式修补

核心矛盾：我们只需要该包中的个别子模块（如 `PGVectorStore`），却被迫承担整个聚合包的依赖冲突。

#### 验证方案 ✅
**不引入 `@langchain/community`，改为自行实现所需组件。** 与 EXP-003 的思路一致——当 `@langchain/community` 中的集成类质量参差不齐或依赖冲突不可控时，基于 `@langchain/core` 的基类自行实现。

已验证的自实现先例：
- **044 章节 `RedisChatHistory`**：继承 `@langchain/core` 的 `BaseListChatMessageHistory`，复用已有 `ioredis`，零新依赖
- **045 章节 `PgVectorStore`**：继承 `@langchain/core` 的 `VectorStore`，复用已有 `pg`，零新依赖

自实现的可行性基础：
- `@langchain/core` 提供了完善的基类（`VectorStore`、`BaseListChatMessageHistory` 等），只需实现 2-3 个抽象方法
- 项目已有对应的底层驱动（`pg`、`ioredis`），无需额外安装
- 自实现代码量可控（RedisChatHistory 约 90 行，PgVectorStore 预计 150-200 行）

#### 反模式 ❌
```bash
# ❌ 使用 .npmrc legacy-peer-deps=true 强行安装 @langchain/community
# 关闭全局 peer dep 校验，掩盖所有包的真实冲突，牺牲安全网

# ❌ 使用 overrides 逐个修补 stagehand 的冲突依赖
# 治标不治本，stagehand 每次更新可能引入新冲突

# ❌ 降级 dotenv/openai 来适配 stagehand
# 为一个不相关的可选依赖降级核心包，因小失大
```

#### 适用条件
- 当 `@langchain/community` 中所需功能可通过 `@langchain/core` 基类 + 已有驱动自行实现时
- `@langchain/core` 提供对应的抽象基类（`VectorStore`、`BaseListChatMessageHistory` 等）
- 若未来 LangChain 将集成拆分为独立包（如 Python 生态的 `langchain-postgres`），可考虑迁移至官方独立包

---

### [EXP-005] BaseMessage：用 `type`，别用 `_getType()` / `getType()`

- **日期**: 2026-03-19
- **关联**: `thread.service.ts` → `serializeMessage`
- **标签**: `#langchain` `#BaseMessage`

**结论**：序列化或要类型字符串时用 **`msg.type`**。`_getType()` / `getType()` 在 `@langchain/core` 1.x 类型上均标弃用。

```typescript
const type = msg.type ?? 'unknown';
```

分支判断优先 `isAIMessage` 等类型守卫，少靠字符串。
