import { AiProvider, ReasoningMode } from './ai.constants';
import { ModelDefinition } from '../interfaces';

/**
 * 模型注册表
 *
 * 所有可用模型的静态声明，作为 GET /ai/models 接口的数据源。
 *
 * 设计决策：
 * - 使用 TypeScript 常量而非数据库，因为模型可用性的真正约束是代码能力
 *   （Factory 适配、LangChain Provider 包、API Key 配置），静态声明与代码支持天然绑定。
 * - 按 provider 分组组织，便于按厂商筛选和后续扩展。
 * - 新增模型时，需同步确认 AiModelFactory 已有对应的工厂方法。
 */
export const MODEL_REGISTRY: readonly ModelDefinition[] = [
  // ============================================================
  // SiliconFlow（硅基流动）— 模型聚合平台
  // ============================================================
  {
    id: 'Pro/MiniMaxAI/MiniMax-M2.5',
    name: 'MiniMax-M2.5 (Pro)',
    provider: AiProvider.SILICONFLOW,
    vendor: 'MiniMax',
    contextWindow: 192_000,
    capabilities: {
      // MiniMax M2 系列采用 Interleaved Thinking 架构，思考始终开启、无法关闭
      reasoningMode: ReasoningMode.ALWAYS,
      streaming: true,
      toolCalls: true,
    },
    pricing: {
      input: 0.0021,
      output: 0.0084,
      cachedInput: 0.00021,
    },
  },
  {
    id: 'Pro/MiniMaxAI/MiniMax-M2.1',
    name: 'MiniMax-M2.1 (Pro)',
    provider: AiProvider.SILICONFLOW,
    vendor: 'MiniMax',
    contextWindow: 192_000,
    capabilities: {
      // MiniMax M2 系列采用 Interleaved Thinking 架构，思考始终开启、无法关闭
      reasoningMode: ReasoningMode.ALWAYS,
      streaming: true,
      toolCalls: true,
    },
    pricing: {
      input: 0.0021,
      output: 0.0084,
      cachedInput: 0.00021,
    },
  },
] as const;
