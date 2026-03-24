import {
  StateGraph,
  StateSchema,
  MessagesValue,
  ReducedValue,
  START,
  END,
} from '@langchain/langgraph';
import type { BaseStore } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { GraphNode, LangGraphRunnableConfig } from '@langchain/langgraph';
import {
  AIMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import * as z from 'zod';

import { executeToolsNode } from '../../shared/nodes/execute-tools.node';
import { shouldContinue, ROUTE } from '../../shared/nodes/should-continue';
import { buildMemorySystemPrompt } from './memory-graph.prompts';
import {
  MemoryType,
  STORE_NAMESPACES,
  type MemoryValue,
} from '../../memory-store';

// ============================================================
// State 定义
// ============================================================

/**
 * 记忆感知 Agent 共享状态定义
 * 每一个节点可以访问和更新这些状态，这些状态会在每个 super-step 边界自动保存 checkpoint
 *
 * Memory-aware Agent 状态定义
 *
 * 在基础 AgentState 之上扩展记忆相关字段：
 * - memoriesLoaded: 检索到的记忆数量
 * - skillsLoaded: 加载的技能数量
 * - memoriesStored: 新提取并存储的记忆数量
 */
export const MemoryAgentState = new StateSchema({
  messages: MessagesValue,
  iterationCount: z.number().default(0),
  // ReducedValue 与共享 AgentState 保持一致，确保 executeToolsNode 类型兼容
  toolCallCount: new ReducedValue(z.number().default(0), {
    reducer: (current: number, update: number) => current + update,
  }),
  memoriesLoaded: z.number().default(0),
  skillsLoaded: z.number().default(0),
  memoriesStored: z.number().default(0),
});

export type MemoryAgentStateType = typeof MemoryAgentState;

// ============================================================
// 运行时上下文
// ============================================================

/**
 * Memory Graph 运行时上下文
 *
 * 通过 contextSchema 从 NestJS DI 层注入到图节点。
 */
export interface MemoryGraphContext {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  maxIterations: number;
  userId: string;
  systemPrompt: string;
  enableMemoryExtraction: boolean;
  enableSkillLoading: boolean;
  /**
   * 技能目录 XML 文本（由 SkillLoaderService.getSkillCatalog() 生成）
   *
   * 始终注入系统提示词（Tier 1），模型通过 load_skill / read_skill_file
   * 工具按需加载完整内容（Tier 2/3）。
   */
  skillCatalog: string;
}

// 不使用 ContextSchema 严格类型约束，而是通过 config.context 手动访问
// 原因：ContextSchema 会将 configurable 的类型绑定到 ContextSchema 的字段定义，
// 与 LangGraph checkpointer 要求的 thread_id 等标准 configurable 字段冲突。
// 这与项目中 shared nodes（call-model.node.ts）的做法一致。

// ============================================================
// 图节点
// ============================================================

/**
 * loadMemories 节点 — 从 Store 检索相关记忆并注入系统提示词
 *
 * 此节点在 callModel 之前执行：
 * 1. 从 runtime.store 中按用户 ID 搜索语义相关的记忆
 * 2. 将技能目录（Tier 1 Catalog）注入系统提示词
 *    技能的完整内容由 Agent 通过 load_skill / read_skill_file 工具按需加载
 * 3. 组装完整的系统提示词（基础 + 记忆 + 技能目录 + 提取指令）
 * 4. 将 SystemMessage 插入消息列表头部
 */
const loadMemoriesNode: GraphNode<MemoryAgentStateType> = async (
  state,
  config,
) => {
  const ctx = config?.context as MemoryGraphContext | undefined;
  const store = config?.store;

  if (!ctx || !store) {
    throw new Error(
      'loadMemories 节点缺少 context 或 store，请通过 contextSchema 和 store 注入',
    );
  }

  // 提取用户最新消息作为搜索查询
  const lastUserMessage = [...state.messages]
    .reverse()
    .find((m: BaseMessage) => m.type === 'human');
  const query =
    typeof lastUserMessage?.content === 'string' ? lastUserMessage.content : '';

  // 搜索相关记忆（Store 向量语义搜索）
  const memoryNamespace = [STORE_NAMESPACES.MEMORIES, ctx.userId];
  let memoryTexts: string[] = [];
  let memoriesLoaded = 0;

  if (query) {
    try {
      const memoryResults = await store.search(memoryNamespace, {
        query,
        limit: 5,
      });
      memoryTexts = memoryResults.map(
        (item) =>
          (item.value as unknown as MemoryValue)?.content ??
          JSON.stringify(item.value),
      );
      memoriesLoaded = memoryResults.length;
    } catch {
      // 搜索失败不应中断对话流程
    }
  }

  // 技能目录已在 context 中预构建（Tier 1），直接注入
  // 技能完整内容通过 load_skill / read_skill_file 工具按需加载（Tier 2/3）
  const skillsLoaded = ctx.enableSkillLoading && ctx.skillCatalog ? 1 : 0;

  // 组装系统提示词
  const systemPrompt = buildMemorySystemPrompt(
    // 基础系统提示词
    ctx.systemPrompt,
    // 检索到的记忆文本列表
    memoryTexts,
    // 技能目录
    ctx.skillCatalog,
    // 是否启用技能加载
    ctx.enableSkillLoading,
    // 是否追加记忆提取指令
    ctx.enableMemoryExtraction,
  );

  // 将系统提示词作为 SystemMessage 放在消息列表开头
  const systemMessage = new SystemMessage({ content: systemPrompt });

  // 过滤已有的 SystemMessage（避免重复注入）
  const nonSystemMessages = state.messages.filter(
    (m: BaseMessage) => m.type !== 'system',
  );

  return {
    messages: [systemMessage, ...nonSystemMessages],
    memoriesLoaded,
    skillsLoaded,
  };
};

/**
 * callModel 节点 — 调用 LLM 生成响应
 *
 * 与共享 callModelNode 类似，但从 MemoryGraphContext 获取模型和工具。
 */
const callModelNode: GraphNode<MemoryAgentStateType> = async (
  state,
  config,
) => {
  const ctx = config?.context as MemoryGraphContext | undefined;
  if (!ctx?.model) {
    throw new Error(
      'callModel 节点缺少 context.model，请通过 contextSchema 注入',
    );
  }

  const { model, tools } = ctx;

  const modelToInvoke =
    tools.length > 0 && typeof model.bindTools === 'function'
      ? model.bindTools(tools)
      : model;

  // MessagesValue reducer 以追加方式处理新消息，loadMemoriesNode 注入的
  // SystemMessage 会被排到已有 HumanMessage 之后。多数 LLM API 要求
  // system 消息在最前面，否则可能忽略系统指令，因此调用前需重排。
  const systemMessages = state.messages.filter(
    (m: BaseMessage) => m.type === 'system',
  );
  const nonSystemMessages = state.messages.filter(
    (m: BaseMessage) => m.type !== 'system',
  );
  const orderedMessages = [...systemMessages, ...nonSystemMessages];

  const response = await modelToInvoke.invoke(orderedMessages);

  const aiMessage = new AIMessage({
    content:
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content),
    tool_calls: response.tool_calls,
    additional_kwargs: response.additional_kwargs,
    response_metadata: response.response_metadata,
    usage_metadata: response.usage_metadata,
  });

  return {
    messages: [aiMessage],
    iterationCount: state.iterationCount + 1,
  };
};

/**
 * extractMemories 节点 — 从模型回复中提取记忆并写入 Store
 *
 * 解析 AI 回复中的 <memory_extract> 标签，提取结构化记忆并持久化。
 * 同时清理回复内容中的 <memory_extract> 块（不暴露给用户）。
 */
const extractMemoriesNode: GraphNode<MemoryAgentStateType> = async (
  state,
  config,
) => {
  const ctx = config?.context as MemoryGraphContext | undefined;
  const store = config?.store;

  if (!ctx || !store) {
    return { memoriesStored: 0 };
  }

  // 获取最后一条 AI 消息
  const lastAiMessage = [...state.messages]
    .reverse()
    .find((m: BaseMessage) => m.type === 'ai');

  if (!lastAiMessage) {
    return { memoriesStored: 0 };
  }

  // 获取最后一条 AI 消息的内容
  const content =
    typeof lastAiMessage.content === 'string' ? lastAiMessage.content : '';

  // 解析 <memory_extract> 标签
  const extractRegex = /<memory_extract>\s*([\s\S]*?)\s*<\/memory_extract>/;
  // 匹配 <memory_extract> 标签的内容
  const match = content.match(extractRegex);

  // 如果匹配失败，则返回存储到的记忆数量为 0
  if (!match) {
    return { memoriesStored: 0 };
  }

  // 存储到的记忆数量
  let memoriesStored = 0;

  try {
    // 解析 <memory_extract> 标签的内容
    const extracted = JSON.parse(match[1]) as Array<{
      type: string;
      content: string;
    }>;

    // 遍历提取的记忆
    for (const entry of extracted) {
      // 获取记忆类型
      const memoryType = Object.values(MemoryType).includes(
        entry.type as MemoryType,
      )
        ? (entry.type as MemoryType)
        : MemoryType.SEMANTIC;

      // 生成记忆唯一标识
      const key = crypto.randomUUID();
      const namespace = [STORE_NAMESPACES.MEMORIES, ctx.userId, memoryType];

      // 创建记忆值
      const value: MemoryValue = {
        content: entry.content,
        type: memoryType,
        source: 'extracted',
      };

      // 存储记忆
      await store.put(
        namespace,
        key,
        value as unknown as Record<string, unknown>,
      );
      memoriesStored++;
    }
  } catch {
    // JSON 解析失败时静默跳过（模型输出格式可能不精确）
  }

  // 清理回复中的 <memory_extract> 块
  const cleanedContent = content.replace(extractRegex, '').trim();

  // 如果清理后的内容与原始内容不同，则替换原始消息
  if (cleanedContent !== content && lastAiMessage instanceof AIMessage) {
    // 创建清理后的消息
    const cleanedMessage = new AIMessage({
      content: cleanedContent,
      tool_calls: lastAiMessage.tool_calls,
      additional_kwargs: lastAiMessage.additional_kwargs,
      response_metadata: lastAiMessage.response_metadata as Record<
        string,
        unknown
      >,
      usage_metadata:
        lastAiMessage.usage_metadata as AIMessage['usage_metadata'],
      id: lastAiMessage.id,
    });

    // 替换原始消息
    const messages = [...state.messages];
    const lastIdx = messages.length - 1;
    // 如果最后一条消息是 AI 消息，则替换为清理后的消息
    if (messages[lastIdx].type === 'ai') {
      messages[lastIdx] = cleanedMessage;
    }

    // 返回替换后的消息和存储到的记忆数量
    return { messages, memoriesStored };
  }

  // 如果清理后的内容与原始内容相同，则返回存储到的记忆数量为 0
  return { memoriesStored };
};

// ============================================================
// 条件路由
// ============================================================

/**
 * shouldContinueOrExtract — 扩展的条件路由
 *
 * callModel 后判断：
 * 1. 有 tool_calls 且未达最大迭代 → executeTools
 * 2. 无 tool_calls → extractMemories（最终回复后提取记忆）
 */
function shouldContinueOrExtract(
  state: {
    messages: BaseMessage[];
    iterationCount: number;
    toolCallCount: number;
  },
  config?: LangGraphRunnableConfig,
): 'executeTools' | 'extractMemories' {
  const result = shouldContinue(state, config);
  if (result === ROUTE.TOOLS) {
    return 'executeTools';
  }
  return 'extractMemories';
}

// ============================================================
// 图构建
// ============================================================

/**
 * 构建 Memory-aware Agent 图
 *
 * 图拓扑：
 * ```
 * ┌─────────┐     ┌──────────────┐     ┌───────────┐
 * │  START  │───▶│ loadMemories │───▶│ callModel │
 * └─────────┘     └──────────────┘     └─────┬─────┘
 *                                            │
 *                               ┌────────────┴────────────┐
 *                               │                         │
 *                          has tool_calls            no tool_calls
 *                               │                         │
 *                               ▼                         ▼
 *                      ┌──────────────┐      ┌──────────────────┐
 *                      │ executeTools │      │ extractMemories  │
 *                      └──────┬───────┘      └────────┬─────────┘
 *                             │                       │
 *                             ▼                       ▼
 *                         callModel                  END
 * ```
 *
 * 与 tool-graph 的关键差异：
 * - 前置 loadMemories 节点：搜索 Store，动态组装系统提示词
 * - 后置 extractMemories 节点：解析 AI 回复，提取并持久化新记忆
 * - 编译时注入 store 参数：节点通过 config.store 访问 BaseStore
 *
 * @param options - 编译选项
 * @param options.checkpointer - 持久化检查点（可选）
 * @param options.store - 长期记忆存储（必须）
 * @returns 编译后的 CompiledStateGraph
 */
export function buildMemoryGraph(options: {
  checkpointer?: BaseCheckpointSaver;
  store: BaseStore;
}) {
  const graph = new StateGraph(MemoryAgentState)
    // 注册 loadMemories 节点
    .addNode('loadMemories', loadMemoriesNode)
    // 注册 callModel 节点
    .addNode('callModel', callModelNode)
    // 注册 executeTools 节点
    .addNode('executeTools', executeToolsNode)
    // 注册 extractMemories 节点
    .addNode('extractMemories', extractMemoriesNode)
    // 创建一条 无条件边：图启动后，第一个执行 loadMemories 节点
    .addEdge(START, 'loadMemories')
    // 创建一条 无条件边：loadMemories 节点执行完后，执行 callModel 节点
    .addEdge('loadMemories', 'callModel')
    // 创建一条 条件边：callModel 节点执行完后，根据 shouldContinueOrExtract 的返回值，决定走向 executeTools 节点还是 extractMemories 节点
    .addConditionalEdges('callModel', shouldContinueOrExtract, {
      executeTools: 'executeTools',
      extractMemories: 'extractMemories',
    })
    // 创建一条 无条件边：executeTools 节点执行完后，执行 callModel 节点
    .addEdge('executeTools', 'callModel')
    // 创建一条 无条件边：extractMemories 节点执行完后，执行 END 节点
    .addEdge('extractMemories', END);

  // 编译图，传入 checkpointer 时启用持久化（每个 super-step 边界自动保存 checkpoint）
  return graph.compile({
    // 传入 checkpointer
    checkpointer: options.checkpointer,
    // 传入 store
    store: options.store,
  });
}

export type MemoryGraphCompiled = ReturnType<typeof buildMemoryGraph>;
