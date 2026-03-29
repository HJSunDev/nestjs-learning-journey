import { registerAs } from '@nestjs/config';

/**
 * AI 服务配置
 *
 * 配置结构：
 * - defaultProvider: 默认使用的 AI 提供商
 * - providers: 各提供商的 API 配置（API Key、Base URL）
 * - defaults: 默认生成参数
 *
 * 环境变量说明：
 * - AI_DEFAULT_PROVIDER: 默认提供商 (siliconflow | deepseek | qwen | moonshot | glm)
 * - SILICONFLOW_API_KEY: 硅基流动 API 密钥（模型聚合平台，可调用多厂商模型）
 * - DEEPSEEK_API_KEY: DeepSeek API 密钥
 * - QWEN_API_KEY: 通义千问 API 密钥
 * - MOONSHOT_API_KEY: Moonshot (Kimi) API 密钥
 * - GLM_API_KEY: 智谱 GLM API 密钥
 * - OPENAI_API_KEY: OpenAI API 密钥（预留）
 * - ANTHROPIC_API_KEY: Anthropic API 密钥（预留）
 * - GOOGLE_AI_API_KEY: Google AI API 密钥（预留）
 */
export default registerAs('ai', () => ({
  // 默认 AI 提供商
  defaultProvider: process.env.AI_DEFAULT_PROVIDER || 'siliconflow',

  // 各提供商配置
  providers: {
    // 硅基流动（模型聚合平台，一个 Key 可调用 MiniMax、DeepSeek、Qwen 等多厂商模型）
    siliconflow: {
      apiKey: process.env.SILICONFLOW_API_KEY,
      baseUrl:
        process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1',
    },

    // DeepSeek（支持推理模型 deepseek-reasoner）
    deepseek: {
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    },

    // 通义千问（支持 enable_thinking 参数启用推理）
    qwen: {
      apiKey: process.env.QWEN_API_KEY,
      baseUrl:
        process.env.QWEN_BASE_URL ||
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
    },

    // Moonshot / Kimi（思考模型如 kimi-k2 支持推理）
    moonshot: {
      apiKey: process.env.MOONSHOT_API_KEY,
      baseUrl: process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.cn/v1',
    },

    // 智谱 GLM（思考模型如 glm-z1-thinking 支持推理）
    glm: {
      apiKey: process.env.GLM_API_KEY,
      baseUrl:
        process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
    },

    // --- 以下为预留配置，暂未在 AiModelFactory 中实现 ---

    // OpenAI
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    },

    // Anthropic (Claude)
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY,
    },

    // Google AI (Gemini)
    google: {
      apiKey: process.env.GOOGLE_AI_API_KEY,
    },
  },

  // 默认生成参数
  defaults: {
    // 温度参数 (0-2)
    temperature: parseFloat(process.env.AI_DEFAULT_TEMPERATURE || '0.7'),
    // 最大输出 Token 数
    maxTokens: parseInt(process.env.AI_DEFAULT_MAX_TOKENS || '4096', 10),
  },

  // RAG 检索增强生成配置
  rag: {
    // Embedding 模型配置（使用 SiliconFlow 的 OpenAI 兼容 API）
    embedding: {
      model: process.env.AI_EMBEDDING_MODEL || 'Qwen/Qwen3-Embedding-8B',
      // Qwen3-Embedding-8B 支持 32~4096 可变维度，默认 4096
      dimensions: parseInt(process.env.AI_EMBEDDING_DIMENSIONS || '1024', 10),
    },
    // 文档切块配置
    splitter: {
      chunkSize: parseInt(process.env.AI_RAG_CHUNK_SIZE || '500', 10),
      chunkOverlap: parseInt(process.env.AI_RAG_CHUNK_OVERLAP || '50', 10),
    },
    // 向量检索默认参数
    retrieval: {
      defaultTopK: parseInt(process.env.AI_RAG_TOP_K || '4', 10),
    },
    // PGVector 向量表名
    tableName: process.env.AI_RAG_TABLE_NAME || 'langchain_documents',
  },

  // 超时配置
  timeout: {
    // 单次 LLM API 调用的 HTTP 超时（毫秒），作用于 Axios 请求层
    perCallMs: parseInt(process.env.AI_TIMEOUT_PER_CALL || '60000', 10),
    // 同步工具调用循环的总超时（毫秒），保护 HTTP 请求不被无限占用。
    // 仅作用于 ToolCallingLoop（同步 HTTP 请求内的工具调用循环），
    // 不适用于未来 LangGraph 的异步长时运行智能体（那类任务有独立的任务级 TTL 和步骤超时）。
    // 设为 0 表示不限制（依赖 perCallMs + maxIterations 提供保护）。
    toolCallingLoopMs: parseInt(
      process.env.AI_TIMEOUT_TOOL_CALLING_LOOP || '300000',
      10,
    ),
  },

  // Checkpoint 持久化配置
  checkpoint: {
    // 是否启用 PostgresSaver 持久化（关闭时退化为 MemorySaver 内存模式）
    enabled: process.env.AI_CHECKPOINT_ENABLED !== 'false',
    // 默认持久化模式：sync（同步，最可靠）| async（异步，高性能）| exit（仅退出时写入）
    durabilityMode:
      (process.env.AI_CHECKPOINT_DURABILITY_MODE as
        | 'sync'
        | 'async'
        | 'exit') || 'sync',
  },

  // 会话记忆配置
  memory: {
    // 默认会话 TTL (Time To Live，生存时间，单位：秒)
    defaultSessionTTL: parseInt(
      process.env.AI_MEMORY_SESSION_TTL || '3600',
      10,
    ),
    defaultWindowSize: parseInt(process.env.AI_MEMORY_WINDOW_SIZE || '20', 10),
    keyPrefix: process.env.AI_MEMORY_KEY_PREFIX || 'chat_history:',
  },

  // 长期记忆 Store 配置（052 章节：BaseStore / PostgresStore）
  store: {
    // 是否启用 PostgresStore（关闭时退化为 InMemoryStore 内存模式）
    enabled: process.env.AI_STORE_ENABLED !== 'false',
    // 记忆 TTL（秒），0 表示永不过期，第二个参数 10 表示十进制
    memoryTtlSeconds: parseInt(process.env.AI_STORE_MEMORY_TTL || '0', 10),
    // 语义搜索默认返回条数
    defaultSearchLimit: parseInt(
      process.env.AI_STORE_DEFAULT_SEARCH_LIMIT || '5',
      10,
    ),
  },

  // 文件系统技能配置（052 章节：Agent Skills 开放标准）
  skills: {
    // 技能目录路径（支持绝对/相对路径，默认 src/ai/skills）
    dir: process.env.AI_SKILLS_DIR || '',
  },

  // 熔断器配置（054 章节：生产级 Agent 运维）
  circuitBreaker: {
    // 连续失败多少次后触发熔断
    consecutiveFailures: parseInt(
      process.env.AI_CIRCUIT_BREAKER_THRESHOLD || '5',
      10,
    ),
    // 熔断后多久（毫秒）进入半开状态尝试恢复
    halfOpenAfterMs: parseInt(
      process.env.AI_CIRCUIT_BREAKER_HALF_OPEN_AFTER || '30000',
      10,
    ),
  },

  // 上下文压缩配置（054 章节：Context Compaction）
  compaction: {
    // 超过此消息数量触发压缩
    maxMessages: parseInt(process.env.AI_COMPACTION_MAX_MESSAGES || '50', 10),
    // 摘要模式下保留最近多少条消息
    preserveRecent: parseInt(
      process.env.AI_COMPACTION_PRESERVE_RECENT || '10',
      10,
    ),
  },

  // MCP 工具配置（054 章节：MCP 工具标准化）
  mcp: {
    // 是否启用 MCP 工具加载
    enabled: process.env.AI_MCP_ENABLED === 'true',
    // MCP 服务器配置（JSON 格式字符串）
    servers: process.env.AI_MCP_SERVERS || '{}',
  },
}));
