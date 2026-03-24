/**
 * 记忆体系类型定义
 *
 * 三类长期记忆的分类学参考：
 * - Semantic（语义记忆）：事实性知识，如用户偏好、个人资料
 * - Episodic（情景记忆）：对话摘要、交互事件
 * - Procedural（程序记忆）：学习到的操作流程、技能指令
 */

/** 记忆类型枚举 */
export enum MemoryType {
  /** 语义记忆 — 事实、偏好、个人资料 */
  SEMANTIC = 'semantic',
  /** 情景记忆 — 对话摘要、交互事件 */
  EPISODIC = 'episodic',
  /** 程序记忆 — 学习到的流程、指令 */
  PROCEDURAL = 'procedural',
}

/** Store 命名空间常量 */
export const STORE_NAMESPACES = {
  MEMORIES: 'memories',
} as const;

/**
 * 记忆条目值（写入 Store 的内容结构）
 */
export interface MemoryValue {
  /** 记忆的文本内容 */
  content: string;
  /** 记忆类型 */
  type: MemoryType;
  /** 来源（手动创建、对话提取、技能注册等） */
  source: 'manual' | 'extracted' | 'skill';
  /** 自定义元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 记忆感知 Agent 调用参数
 * Memory-aware Agent 调用参数
 */
export interface MemoryAgentInvokeParams {
  provider: string;
  model: string;
  messages: import('../../interfaces').Message[];
  systemPrompt?: string;
  /** 用户标识（用于隔离记忆命名空间） */
  userId: string;
  /** 可用工具名称列表 */
  toolNames?: string[];
  /** 最大迭代次数 */
  maxIterations?: number;
  temperature?: number;
  maxTokens?: number;
  /** 是否启用记忆提取（模型自动提取并存储记忆） */
  enableMemoryExtraction?: boolean;
  /** 是否启用技能加载（根据对话上下文动态加载技能） */
  enableSkillLoading?: boolean;
}

/**
 * 记忆感知 Agent 调用结果
 * Memory-aware Agent 调用结果
 */
export interface MemoryAgentInvokeResult {
  content: string;
  /** 本次检索到的记忆数量 */
  memoriesLoaded: number;
  /** 本次加载的技能数量 */
  skillsLoaded: number;
  /** 本次新提取并存储的记忆数量 */
  memoriesStored: number;
  usage?: TokenUsage;
  trace?: TraceSummary;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface TraceSummary {
  traceId: string;
  totalLatencyMs: number;
  llmCallCount: number;
  totalTokens: number;
}

/**
 * Store 配置（从环境变量/ConfigService 读取）
 */
export interface StoreConfig {
  /** 是否启用 PostgresStore（false 退化为 InMemoryStore） */
  enabled: boolean;
  /** 语义搜索的向量维度 */
  embeddingDimensions: number;
  /** 记忆 TTL（秒），0 表示永不过期 */
  memoryTtlSeconds: number;
  /** 检索记忆的默认条数 */
  defaultSearchLimit: number;
}
