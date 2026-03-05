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
