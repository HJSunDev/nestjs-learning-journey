# 042. 结构化输出与 Parser (Structured Output)

## 0. 架构师的真实视角：为什么需要结构化输出

**问题：AI 的自由文本输出无法直接用于程序消费。**

041 的 LCEL 管道 `prompt.pipe(model)` 返回的是 `AIMessageChunk`，其 `content` 是一段自然语言文本。如果需要模型"分析情感并返回置信度"，得到的可能是：

```
这段文本的情感偏向积极，置信度约 0.85，关键词包括"成功"和"突破"。
```

要把这段文字变成可被程序直接处理的 `{ sentiment: 'positive', confidence: 0.85, keywords: ['成功', '突破'] }`，传统做法是手写正则/JSON.parse，不仅脆弱（模型输出格式不稳定），还要处理各种边界情况。

**`withStructuredOutput` 的价值**：让模型在 API 层面就被约束为只能输出符合指定 Schema 的 JSON 对象，输出经 Zod 校验后直接是强类型的 TypeScript 对象。

**在 LCEL 管道中的位置**：

```
041: prompt.pipe(model)                    → AIMessageChunk（自由文本）
042: prompt.pipe(model.withStructuredOutput(schema)) → { raw: AIMessage, parsed: T }（强类型对象）
```

管道结构没变（依然是 prompt → model），只是模型被 `withStructuredOutput` 包装了一层。

---

## 1. 核心概念（从 041 已知出发）

### 1.0 withStructuredOutput 是什么

`withStructuredOutput` 是 LangChain `BaseChatModel` 上的方法，接收一个 Zod Schema，返回一个**新的 Runnable**：

```typescript
// model 是 BaseChatModel（Runnable）
// structuredModel 也是 Runnable，但输出类型不同
const structuredModel = model.withStructuredOutput(zodSchema);
```

**输入输出对比：**

| 组件                                                         | 输入类型          | 输出类型                                 |
| ------------------------------------------------------------ | ----------------- | ---------------------------------------- |
| `model`                                                    | `BaseMessage[]` | `AIMessageChunk`（自由文本）           |
| `model.withStructuredOutput(schema)`                       | `BaseMessage[]` | `z.infer<typeof schema>`（强类型对象） |
| `model.withStructuredOutput(schema, { includeRaw: true })` | `BaseMessage[]` | `{ raw: AIMessageChunk, parsed: T }`   |

因为 `structuredModel` 也是 `Runnable`，它可以无缝替代原始 `model` 参与 `.pipe()` 管道：

```typescript
// 041 管道
const chain041 = prompt.pipe(model);
const result041 = await chain041.invoke(input); // → AIMessageChunk

// 042 管道（仅替换 model → structuredModel）
const chain042 = prompt.pipe(structuredModel);
const result042 = await chain042.invoke(input); // → { raw, parsed }
```

**为什么 model 既有 `invoke`/`pipe` 又有 `withStructuredOutput`？**

`Runnable` 只定义了 `invoke`、`pipe`、`stream`、`batch` 等协议方法。`withStructuredOutput` 不是 `Runnable` 的方法，而是 `BaseChatModel` 在继承 `Runnable` 的基础上**自己扩展**的。完整的继承链：

```
Runnable                     ← invoke / pipe / stream / batch（协议方法）
  └─ BaseLangChain           ← verbose / metadata 等通用属性
       └─ BaseLanguageModel  ← generatePrompt / predict 等语言模型通用方法
            └─ BaseChatModel ← withStructuredOutput / bindTools（对话模型专属方法）
```

`BaseChatModel` 通过继承拥有了 `Runnable` 的全部方法，同时又添加了 `withStructuredOutput`、`bindTools` 等只有对话模型才需要的能力。

需要注意的是，`withStructuredOutput` 的**返回值**类型是 `Runnable`（不是 `BaseChatModel`），因此返回的 `structuredModel` 只有 `invoke`/`pipe`/`stream`/`batch`，**不再拥有** `withStructuredOutput`：

```typescript
const model: BaseChatModel = ...;
model.withStructuredOutput(schema);   // ✅ BaseChatModel 自己的方法

const structuredModel = model.withStructuredOutput(schema);
// structuredModel 的类型是 Runnable，不是 BaseChatModel
structuredModel.invoke(...);          // ✅ Runnable 的方法
structuredModel.withStructuredOutput; // ❌ 不存在
```

这也是为什么 `withStructuredOutput` 必须在 `.pipe()` **之前**调用——一旦通过 `pipe()` 组合进管道，得到的就是通用 `Runnable`，无法再调用 `BaseChatModel` 的专属方法。

### 1.1 结构化输出的三代技术演进

在深入 `withStructuredOutput` 的实现之前，需要理解"让 AI 返回结构化数据"这个需求经历了三代技术方案，约束强度递增：

#### 第一代：Prompt 指令约束（JSON Mode）

最早的做法是在 prompt 中用自然语言告诉模型"请以 JSON 格式输出"：

```
"你必须以 JSON 格式回答，包含 sentiment、confidence 字段..."
```

**原理**：模型在生成 token 时没有任何格式约束，完全靠"理解指令"来尝试输出 JSON。

**问题**：
- 模型可能输出一半 JSON 一半自然语言（"好的，以下是分析结果：{..."）
- 可能漏掉字段、多出字段、enum 值写错
- 格式稳定性完全取决于 prompt 质量和模型的指令跟随能力
- 生产环境需要大量客户端重试和校验逻辑

OpenAI 后来推出了 `response_format: { type: "json_object" }`（JSON Mode），保证输出是语法合法的 JSON，但**不保证符合指定的 Schema**——字段可能多可能少，类型可能错。

**约束强度**：弱。是"请求"模型遵守，不是"强制"。

在 LangChain 中对应的是 `StructuredOutputParser`（链末端文本解析器）和 `withStructuredOutput(schema, { method: 'jsonMode' })`。

#### 第二代：Tool Calling / Function Calling

```typescript
// API 请求中注册一个"函数"
tools: [{
  type: 'function',
  function: {
    name: 'extract_sentiment',
    parameters: {
      type: 'object',
      properties: {
        sentiment: { type: 'string', enum: ['positive', 'negative'] },
        confidence: { type: 'number' }
      },
      required: ['sentiment', 'confidence']
    }
  }
}],
tool_choice: { type: 'function', function: { name: 'extract_sentiment' } }
```

**原理**：模型厂商在训练阶段专门训练了"生成 tool_call 参数"的能力。当注册一个工具并传入其参数的 JSON Schema 时，模型会切换到**专门的 tool calling 生成模式**，输出一个 `tool_call` 对象，其 `arguments` 字段是结构化 JSON。

**与第一代的关键区别**：
- 第一代：模型在**普通文本生成模式**下被要求输出 JSON
- 第二代：模型切换到**训练过的 tool calling 模式**，格式稳定性大幅提升

**但仍然是概率性的**——模型生成 token 时，词表空间没有被裁剪，只是模型"学会了"在 tool calling 模式下大概率输出正确格式。理论上仍可能出现类型错误、enum 越界等问题，只是概率很低。

**约束强度**：中等。是模型"习得的能力"，大幅降低出错率，但不是数学保证。

在 LangChain 中对应的是 `withStructuredOutput(schema)` 的**默认行为**（`method: 'functionCalling'`）。

#### 第三代：Constrained Decoding（受约束解码）

```typescript
// OpenAI 的 Structured Outputs API
response_format: {
  type: 'json_schema',
  json_schema: {
    strict: true,
    schema: { /* JSON Schema */ }
  }
}
```

**原理**：在模型生成每一个 token 之前，根据 JSON Schema 计算出当前位置哪些 token 是合法的，**将不合法的 token 概率设为零**（token masking），然后再从剩余的合法 token 中采样。

```
正常生成：  [全部 vocab] ────────────────────────→ 采样
受约束生成：[全部 vocab] → Schema 合法性过滤 → [合法子集] → 采样
```

举例：如果 Schema 要求 `sentiment` 的值是 `"positive" | "negative"`，当模型生成到 `"sentiment": "` 这个位置时，只有能构成 `positive` 或 `negative` 开头的 token 才被允许，其他所有 token（如 `g`、`b`、`1` 等）概率被强制为零，物理上不可能被选中。

**与第二代的关键区别**：
- 第二代（Tool Calling）：模型"学会了"大概率输出正确格式，但不保证
- 第三代（Constrained Decoding）：在 token 级别**数学上保证**输出必须符合 Schema，违反 Schema 的 token 不可能被生成

**约束强度**：最强。是数学保证，不是概率。无需重试逻辑。

**各厂商支持情况（截至 2026 年初）**：

| 厂商 | 支持程度 | 备注 |
|------|---------|------|
| OpenAI | 正式支持（GPT-4o 及更新） | 2024 年 8 月起，内部使用 Microsoft LLGuidance 引擎 |
| DeepSeek | **Beta 阶段** | 需使用 `https://api.deepseek.com/beta` 端点，`strict: true` |
| Anthropic | 不支持 | 仅支持 tool calling（第二代） |
| SiliconFlow | 平台级支持 | 文档声称所有模型支持，但具体稳定性取决于底层模型 |
| 开源推理框架 | 广泛支持 | vLLM、llama.cpp、SGLang 通过 Outlines/LLGuidance 实现 |

在 LangChain 中对应的是 `withStructuredOutput(schema, { method: 'jsonSchema' })`。

#### 三代技术对比总览

| 维度 | 第一代：Prompt/JSON Mode | 第二代：Tool Calling | 第三代：Constrained Decoding |
|------|------------------------|---------------------|---------------------------|
| 约束位置 | Prompt 文本 | API 请求的 tools 字段 | Token 生成过程 |
| 约束强度 | 弱（请求遵守） | 中等（训练过的能力） | 最强（数学保证） |
| Schema 遵循率 | ~70-90%（取决于 prompt） | ~95-99% | 100% |
| 重试逻辑 | 必须 | 建议 | 不需要 |
| 兼容性 | 几乎所有模型 | 大多数现代模型 | 仅部分厂商/模型 |
| LangChain method | `'jsonMode'` | `'functionCalling'`（默认） | `'jsonSchema'` |

### 1.2 本项目使用的方案及原理

**本项目的 `withStructuredOutput` 默认使用第二代方案：Tool Calling（functionCalling）。**

LangChain 的 `ChatDeepSeek` 类（本项目所有模型的适配器）调用 `withStructuredOutput(zodSchema)` 时，内部执行的完整流程：

```
1. zodToJsonSchema(zodSchema)         → 将 Zod Schema 转为标准 JSON Schema
2. 将 JSON Schema 包装为"伪工具"定义    → { type: 'function', function: { name, parameters: jsonSchema } }
3. bindTools([pseudoTool])            → 注册工具到模型
4. tool_choice: { name: 'SchemaName' } → 强制模型必须调用该"工具"
5. 模型返回 tool_call                  → { name: 'Schema', args: { sentiment: 'positive', ... } }
6. 从 tool_call.args 提取结构化数据
7. zodSchema.parse(args)              → Zod 校验 + 类型转换
8. 返回强类型对象（或 { raw, parsed }）
```

**关键理解**：所谓的"结构化输出"并不是模型在生成正常文本，而是模型被要求"调用一个函数"，函数的参数恰好就是我们想要的结构化数据。这就是为什么 `AIMessage.content` 为空而数据在 `tool_calls[0].args` 里。

LangChain 选择 Tool Calling 作为默认方案的原因是**兼容性最好**——几乎所有现代模型都支持 tool calling，而 Constrained Decoding（`jsonSchema` + `strict`）只有部分厂商和模型支持。

#### LangChain 支持的 method 参数

`withStructuredOutput` 可以通过 `method` 参数显式切换三种策略：

```typescript
// 默认：Tool Calling（第二代，兼容性最好）
model.withStructuredOutput(schema);
model.withStructuredOutput(schema, { method: 'functionCalling' });

// 可选：Constrained Decoding（第三代，需模型/厂商支持）
model.withStructuredOutput(schema, { method: 'jsonSchema' });

// 可选：JSON Mode（第一代，最弱，不推荐）
model.withStructuredOutput(schema, { method: 'jsonMode' });
```

#### 本项目的厂商兼容性

本项目默认使用 SiliconFlow 平台上的 MiniMax-M2.5 模型。根据 SiliconFlow 官方文档：

| 能力 | 明确支持的模型 | MiniMax 支持情况 |
|------|-------------|----------------|
| Function Calling（第二代） | DeepSeek、Qwen、GLM 系列 | **未在 SiliconFlow 支持列表中明确列出** |
| Structured Outputs（第三代） | 文档声称"所有模型"支持 | 实际稳定性取决于底层模型能力 |

如果 MiniMax 模型在 SiliconFlow 上不支持 tool calling，`withStructuredOutput` 的默认策略会失败。**备选方案**：
1. 切换到 SiliconFlow 上明确支持 function calling 的模型（DeepSeek-V3、Qwen 系列）
2. 使用 `method: 'jsonSchema'` 尝试第三代方案（依赖 SiliconFlow 平台的 Structured Outputs 支持）
3. 降级到 `method: 'jsonMode'`（最弱但兼容性最高）

#### 生产级最佳实践

1. **优先使用 Constrained Decoding（第三代）**：如果目标厂商支持 `jsonSchema` + `strict: true`，应优先使用——零重试、100% Schema 遵循。OpenAI GPT-4o+、DeepSeek Beta 端点已支持。

2. **Tool Calling（第二代）作为通用方案**：跨厂商部署时，Tool Calling 是最可靠的通用选择。出错率极低（<1%），但仍需客户端 Zod 校验兜底。

3. **永远不要仅依赖 JSON Mode（第一代）**：在生产环境中，纯 prompt 指令约束的可靠性不够。如果被迫使用，必须配合严格的客户端校验和重试逻辑。

4. **`strict: true` 的约束**：OpenAI/DeepSeek 的 strict 模式要求所有字段必须是 `required`（不允许 `optional`），需要用 `.nullable()` 替代 `.optional()` 来表达"可以不存在"。

5. **模型能力校验**：在 Service 层校验目标模型是否支持所选 method。不支持 tool calling 的模型（如 `deepseek-reasoner`）调用 `withStructuredOutput` 会直接失败。

### 1.2 Zod —— TypeScript 优先的 Schema 验证库

Zod 是 LangChain 推荐的 Schema 定义方式。`import { z } from 'zod'` 中的 **`z` 是 Zod 库的命名空间对象**，所有 Schema 构建方法都挂在它上面（类似 jQuery 的 `$`）。

#### 如何阅读一个 Zod Schema

以项目中的 `SentimentAnalysisSchema` 为例，逐行拆解：

```typescript
import { z } from 'zod';  // z 是 Zod 的命名空间，所有 API 从这里调用

export const SentimentAnalysisSchema = z.object({
  //                                    ^^^^^^^^^ 定义一个"对象结构"
  //                                              大括号内是这个对象包含哪些字段

  sentiment: z.enum(['positive', 'negative', 'neutral', 'mixed']),
  // ↑ 字段名    ↑ 字段类型：枚举，值只能是这四个字符串之一
  // "sentiment" 是 JSON 输出中的 key 名

  confidence: z.number().min(0).max(1),
  // ↑ 字段名     ↑ 数值类型  ↑ 数值 ≥ 0  ↑ 数值 ≤ 1
  // .min() .max() 在 z.number() 上是"数值范围"约束，不是长度

  keywords: z.array(z.string()).max(10),
  // ↑ 字段名  ↑ 数组类型，元素是字符串
  //                           ↑ .max() 在 z.array() 上是"数组长度"约束，最多 10 个元素

  summary: z.string().describe('A brief one-sentence summary'),
  // ↑ 字段名  ↑ 字符串类型  ↑ 描述信息（传给 AI 模型的填充指令）
});
```

**关键理解**：`.min()` / `.max()` 的含义取决于它挂在什么类型上：

| 类型 | `.min(n)` | `.max(n)` |
|------|----------|----------|
| `z.number()` | 数值 ≥ n | 数值 ≤ n |
| `z.string()` | 字符串长度 ≥ n | 字符串长度 ≤ n |
| `z.array()` | 数组元素个数 ≥ n | 数组元素个数 ≤ n |

读完整个 Schema 后，它描述的就是一个 JSON 对象的"契约"——模型输出**必须**是这个结构：

```json
{
  "sentiment": "positive",
  "confidence": 0.85,
  "keywords": ["成功", "突破"],
  "summary": "文本整体情感积极..."
}
```

#### Zod 常用 API 速查

| API | 含义 | 示例 |
|-----|------|------|
| `z.object({...})` | 定义对象结构 | `z.object({ name: z.string() })` |
| `z.string()` | 字符串类型 | `z.string().min(1).max(100)` |
| `z.number()` | 数值类型 | `z.number().min(0).max(1)` |
| `z.boolean()` | 布尔类型 | `z.boolean()` |
| `z.enum([...])` | 枚举（限定可选值） | `z.enum(['a', 'b', 'c'])` |
| `z.array(schema)` | 数组类型 | `z.array(z.string()).max(5)` |
| `.optional()` | 字段可选（可不存在） | `z.string().optional()` |
| `.nullable()` | 值可为 null | `z.string().nullable()` |
| `.describe(text)` | 添加描述（传给 AI） | `z.string().describe('...')` |
| `.default(val)` | 默认值 | `z.number().default(0)` |
| `z.infer<typeof S>` | 从 Schema 推导 TS 类型 | `type T = z.infer<typeof MySchema>` |

**链式调用阅读方法**：从左往右，先读类型，再读约束，最后读描述：

```typescript
z.number().min(0).max(1).describe('Confidence score')
// 读法：数值类型 → 最小 0 → 最大 1 → 描述"置信度分数"
```

#### Zod Schema 等价的 TypeScript 类型

Zod 的核心价值之一是**从 Schema 自动推导出 TypeScript 类型**，省去手动定义 `interface` 再手动校验的重复劳动：

```typescript
const SentimentSchema = z.object({
  sentiment: z.enum(['positive', 'negative', 'neutral']),
  confidence: z.number().min(0).max(1),
  keywords: z.array(z.string()).max(10),
});

// z.infer 自动推导出等价的 TypeScript 类型
type Sentiment = z.infer<typeof SentimentSchema>;
// 等价于手写：
// type Sentiment = {
//   sentiment: 'positive' | 'negative' | 'neutral';
//   confidence: number;
//   keywords: string[];
// }
```

#### Zod vs class-validator 在本项目中的分工

| 职责                 | 工具                                | 原因                                                   |
| -------------------- | ----------------------------------- | ------------------------------------------------------ |
| HTTP 请求校验（DTO） | class-validator + class-transformer | NestJS 管道机制原生集成                                |
| AI 输出格式约束      | Zod                                 | LangChain `withStructuredOutput` 原生要求 Zod Schema |

两者不冲突，各管各的边界：class-validator 管"进"（请求校验），Zod 管"出"（AI 输出约束）。

### 1.3 `.describe()` —— 引导模型的隐形指令

Zod 的 `.describe()` 方法看起来只是文档注释，但在 `withStructuredOutput` 场景下，它会被转换为 JSON Schema 的 `description` 字段，**直接传给模型作为填充指令**：

```typescript
const schema = z.object({
  summary: z.string().describe('A brief one-sentence summary'),
  // ↑ 模型会看到 "summary" 字段需要 "A brief one-sentence summary"
});
```

因此 `.describe()` 的内容质量直接影响模型输出质量。用英文描述通常效果更好（模型训练数据以英文为主），且要具体：

```typescript
// ❌ 模糊
z.string().describe('summary')

// ✅ 具体
z.string().describe('A brief one-sentence summary of the sentiment analysis in the same language as the input')
```

### 1.4 `includeRaw: true` —— 鱼和熊掌兼得

默认情况下，`withStructuredOutput` 只返回解析后的对象，丢失了 `AIMessage` 中的元数据（token usage、finish_reason 等）。

设置 `includeRaw: true` 后，返回值变为 `{ raw: AIMessage, parsed: T }`：

```typescript
const structuredModel = model.withStructuredOutput(schema, {
  includeRaw: true,  // 同时获取原始 AIMessage
});

const result = await structuredModel.invoke(messages);
// result.parsed → 强类型对象
// result.raw    → AIMessage（含 usage_metadata 等）
```

本项目的 `ChatChainBuilder` 统一使用 `includeRaw: true`，在 Service 层分别提取 `parsed`（结构化数据）和 `raw`（token usage）。

### 1.5 温度参数

结构化输出需要模型精确遵循 Schema 格式，`temperature` 越高输出越随机，越容易偏离格式。生产建议：

- 结构化提取任务：`temperature: 0`（确定性最高）
- 需要一定创意的结构化输出（如摘要生成）：`temperature: 0.3`

本项目的 `StructuredExtractRequestDto` 默认 `temperature: 0`。

---

## 2. 核心方案设计

### 场景分析

结构化输出的典型场景都是"从非结构化文本中提取结构化信息"：

| 场景     | Schema                          | 输入              | 输出                                                   |
| -------- | ------------------------------- | ----------------- | ------------------------------------------------------ |
| 情感分析 | `SentimentAnalysisSchema`     | 一段评论/反馈文本 | `{ sentiment, confidence, keywords, summary }`       |
| 实体提取 | `EntityExtractionSchema`      | 一段新闻/文章     | `{ people, organizations, locations, dates }`        |
| 内容分类 | `ContentClassificationSchema` | 一篇文章          | `{ category, tags, language, readingTimeMinutes }`   |
| 代码审查 | `CodeReviewSchema`            | 一段代码          | `{ overallQuality, issues, strengths, suggestions }` |

### 架构设计：Schema Registry 模式

参照已有的 `ToolRegistry`（043 章节工具注册表），设计 **Schema Registry** 管理预定义 Schema：

```
src/ai/schemas/
├── extraction.schemas.ts   ← Zod Schema 定义（纯数据）
├── schema.registry.ts      ← Injectable 注册表（按名查找）
└── index.ts                ← barrel 导出
```

**为什么不让客户端传 JSON Schema？**

- **安全性**：客户端传 Schema 存在注入风险（恶意构造 Schema 触发不可控行为）
- **可靠性**：预定义 Schema 在编译时经过 TypeScript 类型检查
- **可维护性**：Schema 版本受 Git 管控，可回溯

**客户端使用流程：**

1. `GET /ai/lcel/structured/schemas` → 获取可用 Schema 列表
2. 选择 `schemaName`（如 `'sentiment-analysis'`）
3. `POST /ai/lcel/structured/extract` → 传入 `{ schemaName, prompt }` → 获取结构化结果

### 数据流

```
Client (schemaName + prompt)
  → LcelController
    → LcelService.structuredExtract(dto)
      → SchemaRegistry.getSchema(schemaName)    → Zod Schema
      → AiModelFactory.createChatModel(provider) → BaseChatModel
      → ChatChainBuilder.buildStructuredQuickChatChain(model, schema, prompt)
        → model.withStructuredOutput(schema, { includeRaw: true })
        → prompt.pipe(structuredModel)
        → { chain, input }
      → chain.invoke(input)
      → { raw: AIMessage, parsed: Record<string, unknown> }
    → 从 raw 提取 usage / finishReason
    → 返回 StructuredResponseDto { schemaName, data, usage, finishReason }
```

### 与 041 的对比

| 维度     | 041 buildChatChain                 | 042 buildStructuredChatChain                        |
| -------- | ---------------------------------- | --------------------------------------------------- |
| 管道结构 | `prompt.pipe(model)`             | `prompt.pipe(model.withStructuredOutput(schema))` |
| 输出类型 | `AIMessageChunk`（需 normalize） | `{ raw: AIMessageChunk, parsed: T }`              |
| 后处理   | `reasoningNormalizer.normalize`  | 直接取 `parsed`（Zod 已校验）                     |
| 适用场景 | 自由对话                           | 信息提取、分类、分析                                |

---

## 3. 深度原理：三种 method 的内部机制

### 3.1 共同起点：Zod → JSON Schema 转换

无论使用哪种 method，第一步都是将 Zod Schema 转换为标准 JSON Schema：

```typescript
// Zod 定义
const schema = z.object({
  sentiment: z.enum(['positive', 'negative']).describe('Sentiment'),
  confidence: z.number().min(0).max(1).describe('Score'),
});

// LangChain 内部调用 zodToJsonSchema() 转换为：
{
  "type": "object",
  "properties": {
    "sentiment": {
      "type": "string",
      "enum": ["positive", "negative"],
      "description": "Sentiment"
    },
    "confidence": {
      "type": "number",
      "minimum": 0,
      "maximum": 1,
      "description": "Score"
    }
  },
  "required": ["sentiment", "confidence"]
}
```

之后三种 method 的处理路径分叉。

### 3.2 method: 'functionCalling'（默认）—— Tool Calling 路径

转换后的 JSON Schema 被包装成一个 tool definition 并通过 `bindTools` 绑定到模型。同时设置 `tool_choice` 为该工具名，强制模型必须调用它：

```typescript
// withStructuredOutput 内部伪代码（functionCalling 路径）
function withStructuredOutput(schema) {
  const jsonSchema = zodToJsonSchema(schema);
  const toolName = schema.description || 'StructuredOutput';

  const tool = {
    type: 'function',
    function: { name: toolName, parameters: jsonSchema },
  };

  // 绑定工具并强制调用
  return this.bindTools([tool], { tool_choice: toolName })
    .pipe(parseToolCallOutput);
}
```

模型返回的 `AIMessage` 中包含 `tool_calls` 字段，LangChain 从中提取参数并用 Zod 校验：

```typescript
// 模型实际返回的 AIMessage
{
  content: '',  // 空文本（内容在 tool_call 里）
  tool_calls: [{
    name: 'SentimentAnalysis',
    args: { sentiment: 'positive', confidence: 0.92 },
    id: 'call_xxx',
  }],
}

// withStructuredOutput 后处理
const args = aiMessage.tool_calls[0].args;
const parsed = zodSchema.parse(args);  // Zod 校验
return { raw: aiMessage, parsed };
```

如果模型返回的参数不符合 Schema（如 `confidence: 10` 超出 `max(1)`），Zod 的 `.parse()` 会抛出 `ZodError`。

**为什么内容在 `tool_calls` 而不在 `content` 里？**
因为模型认为自己在"调用一个函数"，函数的参数就是结构化数据。模型不是在"回答问题"，而是在"填函数参数"。所以 `content` 为空，数据全部在 `tool_calls[0].args` 中。

### 3.3 method: 'jsonSchema'（Constrained Decoding 路径）

这条路径不走 tool calling，而是通过 `response_format` 参数直接约束模型的文本输出：

```typescript
// withStructuredOutput 内部伪代码（jsonSchema 路径）
function withStructuredOutput(schema) {
  const jsonSchema = zodToJsonSchema(schema);

  // 将 Schema 注入 response_format 字段
  return this.bind({
    response_format: {
      type: 'json_schema',
      json_schema: { strict: true, schema: jsonSchema },
    },
  }).pipe(parseJsonOutput);
}
```

此时模型的文本输出就是 JSON（在 `content` 字段中），而非 tool_call：

```typescript
// 模型实际返回的 AIMessage
{
  content: '{"sentiment":"positive","confidence":0.92}',  // JSON 在 content 里
  tool_calls: [],  // 无 tool_call
}
```

**Constrained Decoding 的底层原理**：

在模型生成每个 token 时，推理引擎根据 JSON Schema 构建一个有限状态机（FSM），在采样前计算当前位置哪些 token 是合法的：

```
位置: {"sentiment":"  →  合法首字母: p(positive) 或 n(negative)
位置: {"sentiment":"p  →  合法: o(ositive)
位置: {"sentiment":"po  →  合法: s(itive)
... 直到完整匹配 "positive"

位置: ","confidence":  →  合法: 0-9 或 0.(小数开头)
```

不合法的 token 概率被设为零（token masking），物理上不可能被采样到。这就是"数学保证"的含义——不是模型"选择"遵守 Schema，而是模型"没有能力"违反 Schema。

OpenAI 内部使用的 LLGuidance 引擎（微软开发，2025 年 5 月起应用于生产）通过 Rust 实现的 Slicer 优化和 Token Trie 数据结构，将每个 token 的合法性检查耗时压缩到约 50 微秒，几乎不影响推理速度。

### 3.4 method: 'jsonMode'（最弱路径）

仅设置 `response_format: { type: 'json_object' }`，保证输出是语法合法的 JSON，但不保证符合指定的 Schema。Schema 信息通过 prompt 注入：

```typescript
// withStructuredOutput 内部伪代码（jsonMode 路径）
function withStructuredOutput(schema) {
  const jsonSchema = zodToJsonSchema(schema);
  const formatInstructions = `Output valid JSON matching: ${JSON.stringify(jsonSchema)}`;

  return this.bind({
    response_format: { type: 'json_object' },
  }).pipe(
    addSystemMessage(formatInstructions),  // Schema 信息放在 prompt 里
    parseJsonOutput,
  );
}
```

这本质上就是第一代方案，只是 LangChain 替你自动注入了 format instructions。

### 3.5 三种路径的输出位置对比

| method | 数据在 AIMessage 的位置 | 约束机制 |
|--------|----------------------|---------|
| `functionCalling` | `tool_calls[0].args` | 模型训练过的 tool calling 能力 |
| `jsonSchema` | `content`（JSON 字符串） | Token 级别的合法性过滤 |
| `jsonMode` | `content`（JSON 字符串） | 仅保证是合法 JSON，Schema 靠 prompt |

---

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

### 4.1 方案选择策略（生产级决策树）

```
需要结构化输出
│
├─ 目标厂商支持 jsonSchema + strict?
│   ├─ 是 → 使用 method: 'jsonSchema'（第三代，最强，零重试）
│   └─ 否 ─┬─ 目标模型支持 tool calling?
│           ├─ 是 → 使用默认 method: 'functionCalling'（第二代）
│           │       配合 Zod 校验兜底 + 可选重试
│           └─ 否 → 使用 method: 'jsonMode'（第一代）
│                   必须配合严格校验 + 重试逻辑
│                   考虑是否切换模型
```

**核心原则**：能用第三代就不用第二代，能用第二代就不用第一代。跨厂商部署时第二代（Tool Calling）是安全的通用选择。

### 4.2 Schema 设计

- ✅ 对每个 Zod 字段使用 `.describe()` 提供清晰的填充指令，这是影响输出质量的关键
- ✅ `.describe()` 使用英文描述效果通常更好（模型训练数据以英文为主），且要具体
- ❌ 避免在 `.describe()` 中使用模糊描述（如 "the data"），应明确字段用途和格式要求
- ❌ 避免定义过于复杂的嵌套 Schema（超过 3 层嵌套），模型遵循能力会显著下降
- ⚠️ 若使用 `strict: true`（第三代），所有字段必须在 `required` 中——用 `.nullable()` 而非 `.optional()` 表示"可以不存在"

### 4.3 API 与链路

- ✅ 使用 `withStructuredOutput` 而非 `StructuredOutputParser`，前者利用 tool calling 或 constrained decoding 约束格式，后者依赖模型自觉遵循指令
- ✅ 使用 `includeRaw: true` 同时获取结构化数据和 token usage 元数据
- ✅ 结构化提取任务使用低温度（`temperature: 0`）以提高格式一致性
- ✅ 预定义 Schema 注册到 Registry，避免客户端传递动态 Schema 带来的安全风险
- ❌ 避免对不支持 tool calling 的模型使用结构化输出（如 `deepseek-reasoner`），需在 Service 层校验
### 4.4 结构化输出与流式传输的关系

**核心矛盾**：结构化输出需要完整 JSON 才能校验，这与流式的"逐 token 返回"天然冲突。

**普通流式 vs 结构化输出流式：**

```
普通流式（model.stream）：
  → "今天" → "天气" → "不错" → ...
  每个 chunk 是文本片段，可立即展示给用户

结构化输出流式（structuredModel.stream）：
  Tool Calling 路径下，数据在 tool_calls[0].args 中，是 JSON 字符串：
  → '{"sentim'
  → '{"sentiment":"posit'
  → '{"sentiment":"positive","confi'
  → '{"sentiment":"positive","confidence":0.85,...}'
  中间的每一个 chunk 都是不完整的 JSON 片段，无法通过 Zod 校验
```

**LangChain 的实际行为**：

`withStructuredOutput` 返回的 Runnable 调用 `.stream()` **不会报错**，但返回的不是文本流，而是"逐步填充的部分对象流"——LangChain 在内部做增量 JSON 解析（partial parsing），每收到新 chunk 就尝试解析已有部分并 emit：

```typescript
const structuredModel = model.withStructuredOutput(schema);
const stream = await structuredModel.stream(messages);

for await (const chunk of stream) {
  console.log(chunk);
}
// { }                                        ← 第 1 个 chunk：空对象
// { sentiment: 'positive' }                   ← 第 2 个 chunk：填充了 1 个字段
// { sentiment: 'positive', confidence: 0.85 } ← 第 3 个 chunk：填充了 2 个字段
// { sentiment: 'positive', confidence: 0.85, keywords: ['成功'], summary: '...' }
//                                             ← 最后一个 chunk：完整对象
```

这些中间 chunk 是**缺少字段的部分对象**，不能通过完整的 Zod Schema 校验，只有最后一个 chunk 才是完整的。

**这种"部分对象流"有用吗？**

对于前端逐字显示场景——没用。用户不需要看到 `{ sentiment: 'positive' }` 逐步填充。

理论上可用于"大型结构化输出的进度展示"（如代码审查返回 20 个 issue，逐个出现），但实际场景极少，且增加了前端和后端的复杂度。

**结论**：

| 调用方式 | 是否可用 | 返回内容 |
|---------|---------|---------|
| `model.invoke(messages)` | ✅ | `AIMessageChunk`（完整文本） |
| `model.stream(messages)` | ✅ | 逐 token 文本片段流 |
| `structuredModel.invoke(messages)` | ✅ | `{ raw, parsed }`（完整结构化对象） |
| `structuredModel.stream(messages)` | ⚠️ 可调用但不实用 | 逐步填充的部分对象流 |

**本项目的选择**：结构化输出统一使用 `chain.invoke()`。结构化提取的数据量通常较小（几百 token），延迟可接受。如果需要给用户"正在处理"的反馈，用 loading 状态而非流式文本。

### 4.5 生产级健壮性

- ✅ 即使使用 Tool Calling（第二代），客户端也应保留 Zod `.parse()` 校验——作为最后一道防线
- ✅ 对于关键业务链路，考虑实现自动重试机制：当 Zod 校验失败时，自动重新调用模型（建议最多重试 2 次）
- ✅ 记录所有 Zod 校验失败的 case，用于分析模型输出质量和 Schema 设计缺陷
- ✅ 在选型时，对目标模型和平台进行 structured output 的兼容性测试，而非仅依赖文档声明

### 4.6 本项目的防御策略实现

本项目在结构化输出链路上实施了三层防御，覆盖"调用前 → 调用后 → 错误响应"全链路：

**第一层：调用前——模型能力预检（`validateStructuredOutputSupport`）**

不使用硬编码黑名单，而是从 `MODEL_REGISTRY` 中查找模型定义，依据 `capabilities.toolCalls` 判断能力：

```typescript
private validateStructuredOutputSupport(provider: AiProvider, modelId: string): void {
  const modelDef = MODEL_REGISTRY.find(
    (m) => m.id === modelId && m.provider === provider,
  );

  // 注册表中未声明的模型：放行并警告，避免因注册表不全而误拦
  if (!modelDef) {
    this.logger.warn(`模型 "${modelId}" 未在 MODEL_REGISTRY 中注册，跳过预检`);
    return;
  }

  // 注册表中明确声明不支持 tool calling 的模型：拦截
  if (!modelDef.capabilities.toolCalls) {
    throw new BadRequestException('...');
  }
}
```

设计决策：
- 依据 `MODEL_REGISTRY` 已有的 `toolCalls` 字段，**遵循 OCP**（新增模型只需在注册表声明能力，无需修改校验逻辑）
- 对未注册模型采用**放行+警告**策略，而非拒绝——避免因注册表滞后而误拦合法请求
- 使用 `provider + modelId` 联合匹配，同一模型在不同平台上的能力可能不同

**第二层：调用后——解析结果兜底校验（`guardParsedResult`）**

`withStructuredOutput` 内部已做 Zod parse，但某些边界情况可能导致 `parsed` 为空：

```typescript
private guardParsedResult(
  parsed: Record<string, unknown> | null | undefined,
  schemaName: string,
): asserts parsed is Record<string, unknown> {
  if (!parsed || typeof parsed !== 'object') {
    throw new BadRequestException(
      `结构化输出解析失败（Schema: ${schemaName}）...`,
    );
  }
}
```

使用 TypeScript 的 `asserts` 类型谓词，校验通过后编译器自动收窄类型，后续代码无需再做 null 检查。

**第三层：Schema 查找——正确的 HTTP 状态码（`SchemaRegistry`）**

客户端传入不存在的 `schemaName` 时，返回 `404 Not Found` 而非 `500 Internal Server Error`：

```typescript
// SchemaRegistry.getSchema()
if (!entry) {
  throw new NotFoundException(`Schema "${name}" 不存在。可用: ${available}`);
}
```

**三层防御的分工：**

| 层次 | 时机 | 检查内容 | HTTP 状态码 |
|------|------|---------|-----------|
| 第一层 | 调用模型之前 | 模型是否支持 tool calling | 400 |
| Schema 查找 | 调用模型之前 | schemaName 是否存在 | 404 |
| 第二层 | 调用模型之后 | parsed 结果是否有效 | 400 |

**现阶段有意不做的事（及原因）：**

| 措施 | 为什么不做 |
|------|-----------|
| 自动重试 | 属于通用可靠性机制，适合在后续重试/容错章节系统引入 |
| method 降级链（functionCalling → jsonSchema → jsonMode） | 增加链路复杂度，当前单一策略足以满足学习和演示需求 |
| 熔断器 | 模型服务不稳定时的保护机制，属于更高级的可靠性话题 |
| 结构化输出成功率监控 | 需要引入可观测性基础设施，超出当前章节范围 |

---

## 5. 行动导向 (Action Guide)

### Step 1: 安装 Zod 依赖

**这一步在干什么**：Zod 是 LangChain `withStructuredOutput` 要求的 Schema 定义库。`@langchain/core` 的 peer dependency 中已声明对 Zod 的依赖，但需要显式安装到项目中。

```bash
npm install zod
```

### Step 2: 创建 Schema 定义层

**这一步在干什么**：定义预置的 Zod Schema，每个 Schema 对应一种结构化提取任务。`.describe()` 的内容会被传给模型作为字段填充指令。

创建 `src/ai/schemas/extraction.schemas.ts`：

```typescript
import { z } from 'zod';

// 情感分析 Schema
export const SentimentAnalysisSchema = z.object({
  sentiment: z
    .enum(['positive', 'negative', 'neutral', 'mixed'])
    .describe('The overall sentiment of the text'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('Confidence score between 0 and 1'),
  keywords: z
    .array(z.string())
    .max(10)
    .describe('Key words or phrases that indicate the sentiment'),
  summary: z
    .string()
    .describe('A brief one-sentence summary of the sentiment analysis'),
});

// z.infer 自动推导 TypeScript 类型
export type SentimentAnalysis = z.infer<typeof SentimentAnalysisSchema>;

// 实体提取 Schema
const PersonSchema = z.object({
  name: z.string().describe('Full name of the person'),
  role: z
    .string()
    .optional()
    .describe('Role or title of the person, if mentioned'),
});

export const EntityExtractionSchema = z.object({
  people: z
    .array(PersonSchema)
    .describe('List of people mentioned in the text'),
  organizations: z
    .array(z.string())
    .describe('List of organizations or companies mentioned'),
  locations: z
    .array(z.string())
    .describe('List of geographical locations mentioned'),
  dates: z
    .array(z.string())
    .describe('List of dates or time references mentioned'),
});

export type EntityExtraction = z.infer<typeof EntityExtractionSchema>;

// 内容分类 Schema
export const ContentClassificationSchema = z.object({
  category: z
    .enum([
      'technology', 'business', 'science', 'health',
      'entertainment', 'education', 'politics', 'other',
    ])
    .describe('The primary category of the content'),
  tags: z.array(z.string()).max(5).describe('Up to 5 relevant topic tags'),
  language: z
    .string()
    .describe('The language of the content (e.g. "zh-CN", "en")'),
  readingTimeMinutes: z
    .number()
    .min(1)
    .describe('Estimated reading time in minutes'),
});

export type ContentClassification = z.infer<typeof ContentClassificationSchema>;

// 代码审查 Schema
const CodeIssueSchema = z.object({
  line: z
    .number()
    .optional()
    .describe('Approximate line number where the issue occurs'),
  severity: z
    .enum(['critical', 'warning', 'suggestion'])
    .describe('Severity level of the issue'),
  description: z.string().describe('Brief description of the issue'),
  fix: z.string().optional().describe('Suggested fix for the issue'),
});

export const CodeReviewSchema = z.object({
  overallQuality: z
    .enum(['excellent', 'good', 'acceptable', 'needs_improvement', 'poor'])
    .describe('Overall code quality assessment'),
  issues: z
    .array(CodeIssueSchema)
    .describe('List of identified issues in the code'),
  strengths: z.array(z.string()).describe('Positive aspects of the code'),
  suggestions: z.array(z.string()).describe('General improvement suggestions'),
});

export type CodeReview = z.infer<typeof CodeReviewSchema>;
```

### Step 3: 创建 Schema Registry

**这一步在干什么**：参照 `ToolRegistry` 的模式，创建一个 Injectable 注册表服务，管理所有预定义 Schema。客户端通过 `schemaName` 查找对应的 Zod Schema，比传递动态 JSON Schema 更安全（防注入）。

创建 `src/ai/schemas/schema.registry.ts`：

```typescript
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ZodObject, ZodRawShape } from 'zod';
import {
  SentimentAnalysisSchema,
  EntityExtractionSchema,
  ContentClassificationSchema,
  CodeReviewSchema,
} from './extraction.schemas';

export interface SchemaEntry {
  name: string;
  description: string;
  schema: ZodObject<ZodRawShape>;
}

export interface SchemaListItem {
  name: string;
  description: string;
  fields: Record<string, string>;
}

@Injectable()
export class SchemaRegistry {
  private readonly logger = new Logger(SchemaRegistry.name);
  private readonly schemas = new Map<string, SchemaEntry>();

  constructor() {
    this.registerBuiltinSchemas();
  }

  private registerBuiltinSchemas(): void {
    this.register({
      name: 'sentiment-analysis',
      description: '情感分析：识别文本的情感倾向、置信度和关键词',
      schema: SentimentAnalysisSchema as ZodObject<ZodRawShape>,
    });
    // ... 其他 Schema 注册
    this.logger.log(`Schema 注册完成，共 ${this.schemas.size} 个可用 Schema`);
  }

  register(entry: SchemaEntry): void { /* ... */ }

  getSchema(name: string): ZodObject<ZodRawShape> {
    const entry = this.schemas.get(name);
    if (!entry) {
      // 抛出 NotFoundException（404）而非裸 Error（500）
      throw new NotFoundException(`Schema "${name}" 不存在。可用: ${this.getNames().join(', ')}`);
    }
    return entry.schema;
  }

  listSchemas(): SchemaListItem[] { /* ... */ }
}
```

创建 `src/ai/schemas/index.ts`：

```typescript
export * from './extraction.schemas';
export * from './schema.registry';
```

### Step 4: 扩展 ChatChainBuilder

**这一步在干什么**：在现有的 `ChatChainBuilder` 中新增两个结构化输出链构建方法。核心操作是用 `model.withStructuredOutput(schema, { includeRaw: true })` 包装模型，然后与 prompt 组成管道。

在 `src/ai/chains/chat-chain.builder.ts` 中新增：

```typescript
import type { ZodObject, ZodRawShape } from 'zod';

// 在类中新增两个方法

buildStructuredChatChain(
  model: BaseChatModel,
  schema: ZodObject<ZodRawShape>,
  messages: Message[],
  systemPrompt?: string,
): PreparedChain {
  const prompt = createChatPrompt(systemPrompt, hasSystemMessage(messages));
  const structuredModel = model.withStructuredOutput(schema, {
    includeRaw: true,
  });

  return {
    chain: prompt.pipe(structuredModel),
    input: { messages: convertToLangChainMessages(messages) },
  };
}

buildStructuredQuickChatChain(
  model: BaseChatModel,
  schema: ZodObject<ZodRawShape>,
  userInput: string,
  systemPrompt?: string,
): PreparedChain {
  const prompt = createQuickChatPrompt(systemPrompt);
  const structuredModel = model.withStructuredOutput(schema, {
    includeRaw: true,
  });

  return {
    chain: prompt.pipe(structuredModel),
    input: { input: userInput },
  };
}
```

**与 041 `buildChatChain` 对比**：

```typescript
// 041: prompt.pipe(model) → AIMessageChunk
chain: prompt.pipe(model)

// 042: prompt.pipe(structuredModel) → { raw, parsed }
const structuredModel = model.withStructuredOutput(schema, { includeRaw: true });
chain: prompt.pipe(structuredModel)
```

唯一的差异是在 `pipe` 之前用 `withStructuredOutput` 包装了 model。管道的入参不变（`messages` 或 `input`），出参从 `AIMessageChunk` 变为 `{ raw, parsed }`。

### Step 5: 创建请求/响应 DTO

**这一步在干什么**：定义结构化输出场景的请求和响应 DTO。请求 DTO 新增 `schemaName` 字段指定要使用的 Schema。

创建 `src/ai/dto/structured-request.dto.ts`：

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber, IsEnum, /* ... */ } from 'class-validator';
import { AiProvider } from '../constants';

// 多轮结构化对话
export class StructuredChatRequestDto {
  @IsEnum(AiProvider)
  provider: AiProvider = AiProvider.SILICONFLOW;

  @IsString()
  model: string = 'Pro/MiniMaxAI/MiniMax-M2.5';

  @IsString()
  schemaName: string;  // 关键新字段：指定 Schema 名称

  @ValidateNested({ each: true })
  messages: StructuredMessageDto[];

  @IsOptional()
  systemPrompt?: string;

  @IsOptional()
  temperature?: number;  // 默认 0
}

// 单轮快速提取
export class StructuredExtractRequestDto {
  provider: AiProvider;
  model: string;
  schemaName: string;
  prompt: string;        // 待分析文本
  systemPrompt?: string;
  temperature?: number;  // 默认 0
}

// 统一响应
export class StructuredResponseDto {
  schemaName: string;
  data: Record<string, unknown>;  // 结构化数据
  usage?: { promptTokens, completionTokens, totalTokens };
  finishReason?: string;
}
```

更新 `src/ai/dto/index.ts`：

```typescript
export * from './structured-request.dto';
```

### Step 6: 扩展 LcelService

**这一步在干什么**：在 `LcelService` 中注入 `SchemaRegistry`，新增 `structuredChat`、`structuredExtract`、`getAvailableSchemas` 三个方法。Service 层负责：从 Registry 获取 Schema → 创建模型 → 委托 Builder 构建管道 → 调用并提取结果。

在 `src/ai/lcel.service.ts` 中新增：

```typescript
import { SchemaRegistry, type SchemaListItem } from './schemas';
import { StructuredChatRequestDto, StructuredExtractRequestDto, StructuredResponseDto } from './dto';

// 构造函数新增注入
constructor(
  private readonly modelFactory: AiModelFactory,
  private readonly reasoningNormalizer: ReasoningNormalizer,
  private readonly chainBuilder: ChatChainBuilder,
  private readonly schemaRegistry: SchemaRegistry,  // 新增
) {}

// 获取可用 Schema 列表
getAvailableSchemas(): SchemaListItem[] {
  return this.schemaRegistry.listSchemas();
}

// 多轮结构化对话
async structuredChat(dto: StructuredChatRequestDto): Promise<StructuredResponseDto> {
  // 第一层防御：模型能力预检（依据 MODEL_REGISTRY 的 toolCalls 字段）
  this.validateStructuredOutputSupport(dto.provider, dto.model);

  const schema = this.schemaRegistry.getSchema(dto.schemaName);
  const model = this.modelFactory.createChatModel(dto.provider, {
    model: dto.model,
    temperature: dto.temperature ?? 0,
    maxTokens: dto.maxTokens,
  });

  const { chain, input } = this.chainBuilder.buildStructuredChatChain(
    model, schema, dto.messages, dto.systemPrompt,
  );

  const result = await chain.invoke(input) as { raw: AIMessageChunk, parsed: Record<string, unknown> };

  // 第二层防御：解析结果兜底校验
  this.guardParsedResult(result.parsed, dto.schemaName);

  return {
    schemaName: dto.schemaName,
    data: result.parsed,
    usage: this.extractTokenUsage(result.raw),
    finishReason: this.extractFinishReason(result.raw),
  };
}

// 模型能力预检：依据 MODEL_REGISTRY 而非硬编码黑名单
private validateStructuredOutputSupport(provider: AiProvider, modelId: string): void {
  const modelDef = MODEL_REGISTRY.find(
    (m) => m.id === modelId && m.provider === provider,
  );

  if (!modelDef) {
    this.logger.warn(`模型 "${modelId}" 未在 MODEL_REGISTRY 中注册，跳过预检`);
    return;
  }

  if (!modelDef.capabilities.toolCalls) {
    throw new BadRequestException(
      `模型 "${modelDef.name}"（${modelId}）不支持 tool calling，无法使用结构化输出。`,
    );
  }
}

// 解析结果兜底校验：防止 null/undefined 静默返回
private guardParsedResult(
  parsed: Record<string, unknown> | null | undefined,
  schemaName: string,
): asserts parsed is Record<string, unknown> {
  if (!parsed || typeof parsed !== 'object') {
    throw new BadRequestException(
      `结构化输出解析失败（Schema: ${schemaName}）。模型未返回有效的结构化数据。`,
    );
  }
}
```

### Step 7: 扩展 LcelController

**这一步在干什么**：在 `LcelController` 中新增三个端点，暴露结构化输出能力。

在 `src/ai/lcel.controller.ts` 中新增：

```typescript
// GET /ai/lcel/structured/schemas — 查看可用 Schema
@Public()
@Get('structured/schemas')
getAvailableSchemas() {
  return this.lcelService.getAvailableSchemas();
}

// POST /ai/lcel/structured/chat — 多轮结构化对话
@Public()
@Post('structured/chat')
@HttpCode(HttpStatus.OK)
async structuredChat(@Body() dto: StructuredChatRequestDto): Promise<StructuredResponseDto> {
  return this.lcelService.structuredChat(dto);
}

// POST /ai/lcel/structured/extract — 单轮快速提取
@Public()
@Post('structured/extract')
@HttpCode(HttpStatus.OK)
async structuredExtract(@Body() dto: StructuredExtractRequestDto): Promise<StructuredResponseDto> {
  return this.lcelService.structuredExtract(dto);
}
```

### Step 8: 更新模块注册

**这一步在干什么**：在 `AiModule` 中注册 `SchemaRegistry`，使其可被 NestJS 依赖注入系统管理。

在 `src/ai/ai.module.ts` 中：

```typescript
import { SchemaRegistry } from './schemas';

@Module({
  providers: [
    // ... 现有 providers
    SchemaRegistry,  // 新增
  ],
  exports: [
    // ... 现有 exports
    SchemaRegistry,  // 新增
  ],
})
export class AiModule {}
```

### Step 9: 验证

```bash
# TypeScript 编译检查
npx tsc --noEmit

# ESLint 检查（仅修改过的文件）
npx eslint src/ai/schemas/extraction.schemas.ts \
  src/ai/schemas/schema.registry.ts \
  src/ai/chains/chat-chain.builder.ts \
  src/ai/dto/structured-request.dto.ts \
  src/ai/lcel.service.ts \
  src/ai/lcel.controller.ts \
  src/ai/ai.module.ts
```

启动后通过 Swagger UI 测试：

```bash
# 1. 查看可用 Schema
GET /ai/lcel/structured/schemas

# 2. 情感分析
POST /ai/lcel/structured/extract
{
  "schemaName": "sentiment-analysis",
  "prompt": "这家餐厅的服务态度非常好，菜品也很美味，但价格偏高。"
}

# 3. 实体提取
POST /ai/lcel/structured/extract
{
  "schemaName": "entity-extraction",
  "prompt": "2024年3月，马斯克在得克萨斯州宣布 SpaceX 星舰第三次试飞成功。"
}

# 4. 多轮结构化对话
POST /ai/lcel/structured/chat
{
  "schemaName": "content-classification",
  "messages": [
    { "role": "user", "content": "请分析这篇文章：NestJS 是一个基于 TypeScript 的服务端框架..." }
  ]
}
```
