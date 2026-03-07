import { AiProvider, ReasoningMode } from '../constants';

/**
 * 模型能力声明
 *
 * 标识模型支持的功能特性，前端据此决定 UI 交互（如是否显示推理面板、是否启用流式等）。
 */
export interface ModelCapabilities {
  /**
   * 推理模式
   *
   * - none:   不具备推理能力，请求推理时应提示用户切换模型
   * - always: 始终推理（如 deepseek-reasoner），无需额外参数
   * - hybrid: 可选推理（如 qwen-plus），需通过 API 参数显式开启
   */
  reasoningMode: ReasoningMode;
  /** 支持流式 SSE 响应 */
  streaming: boolean;
  /** 支持工具/函数调用 */
  toolCalls: boolean;
}

/**
 * 模型定价信息（单位：元 / 千 Tokens）
 */
export interface ModelPricing {
  /** 输入 Token 单价 */
  input: number;
  /** 输出 Token 单价 */
  output: number;
  /** 缓存命中输入 Token 单价 */
  cachedInput?: number;
}

/**
 * 模型定义
 *
 * 描述一个可用 AI 模型的完整元数据。
 * 作为静态注册表的数据结构，同时也是 /ai/models 接口的响应基础。
 *
 * provider 与 vendor 的区别：
 * - provider: API 提供商（如 siliconflow），决定调用哪个 API 端点
 * - vendor:   模型原始厂商（如 MiniMax），标识模型的实际制造方
 * 聚合平台（如硅基流动）下，一个 provider 可承载多个 vendor 的模型。
 */
export interface ModelDefinition {
  /** 模型唯一标识，即传给 API 的 model 参数值 */
  id: string;
  /** 前端展示名称 */
  name: string;
  /** API 提供商（决定调用路由和鉴权） */
  provider: AiProvider;
  /** 模型原始厂商 */
  vendor: string;
  /** 最大上下文窗口（Token 数） */
  contextWindow: number;
  /** 模型能力声明 */
  capabilities: ModelCapabilities;
  /** 定价信息（元 / 千 Tokens） */
  pricing?: ModelPricing;

  /**
   * hybrid 模式下开启推理所需的 API 参数
   *
   * 当 enableReasoning=true 时，这些参数会通过 modelKwargs 注入请求体。
   * 仅 reasoningMode=hybrid 的模型需要声明；always/none 模型不需要。
   *
   * 各厂商格式不同，例如：
   * - Qwen:  { enable_thinking: true }
   * - GLM:   { thinking: { type: 'enabled' } }
   *
   * 设计决策：将推理参数绑定到模型而非平台，
   * 因为聚合平台（如 SiliconFlow）上同一 provider 下不同 vendor 的模型
   * 有完全不同的推理参数格式。
   */
  reasoningKwargs?: Record<string, unknown>;
}
