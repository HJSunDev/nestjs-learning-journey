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
使用厂商专用的 LangChain 集成类，绕开 `ChatOpenAI` 的消息转换管道：
- DeepSeek → `ChatDeepSeek` (`@langchain/deepseek`)
- Qwen → `ChatAlibabaTongyi` (`@langchain/community`)
- Moonshot → `ChatMoonshot` (`@langchain/community`)
- GLM → `ChatZhipuAI` (`@langchain/community`)
- OpenAI o1/o3 → 等待官方修复，或使用原生 OpenAI SDK 直接调用后手动构造 AIMessage

这些厂商专用类各自实现了响应解析，已正确处理 `reasoning_content` 的提取（`@langchain/deepseek` 官方文档示例已验证 `additional_kwargs.reasoning_content` 可正常获取）。

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
