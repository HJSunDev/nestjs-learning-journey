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
 * - AI_DEFAULT_PROVIDER: 默认提供商 (deepseek | qwen | moonshot | glm)
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
  defaultProvider: process.env.AI_DEFAULT_PROVIDER || 'moonshot',

  // 各提供商配置
  providers: {
    // DeepSeek（推荐，支持推理模型 deepseek-reasoner）
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
      baseUrl:
        process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.cn/v1',
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
}));
