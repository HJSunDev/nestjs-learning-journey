import { Injectable, Logger } from '@nestjs/common';

/**
 * 归一化后的聊天输出
 *
 * 屏蔽不同厂商模型的推理字段差异，为上层提供统一的输出结构。
 */
export interface NormalizedChatOutput {
  /** 正式文本内容 */
  content: string;
  /** 推理/思考过程（无推理数据时为 null） */
  reasoning: string | null;
}

/**
 * 推理内容提取策略函数
 *
 * 从 LangChain AIMessage/AIMessageChunk 的 additional_kwargs 中
 * 提取推理内容。不同厂商的字段位置可能不同。
 */
type ReasoningExtractFn = (
  additionalKwargs: Record<string, any>,
) => string | null;

/**
 * 厂商推理字段提取策略注册表
 *
 * 各厂商 LLM 的推理内容（Chain of Thought）在 LangChain 输出中的位置：
 *
 * | 厂商      | LangChain 类        | 字段路径                              | 启用方式                            |
 * |-----------|---------------------|---------------------------------------|-------------------------------------|
 * | DeepSeek  | ChatDeepSeek        | additional_kwargs.reasoning_content   | 使用推理模型 (如 deepseek-reasoner)  |
 * | Qwen      | ChatAlibabaTongyi   | additional_kwargs.reasoning_content   | 参数 enable_thinking: true           |
 * | Moonshot  | ChatMoonshot        | additional_kwargs.reasoning_content   | 使用思考模型 (如 kimi-k2)            |
 * | GLM       | ChatZhipuAI         | additional_kwargs.reasoning_content   | 使用思考模型 (如 glm-z1-thinking)    |
 *
 * 扩展方式：新增厂商时，只需在此映射中添加对应的提取函数。
 */
const REASONING_EXTRACTORS: Record<string, ReasoningExtractFn> = {
  deepseek: (kwargs) => kwargs?.reasoning_content ?? null,
  qwen: (kwargs) => kwargs?.reasoning_content ?? null,
  moonshot: (kwargs) => kwargs?.reasoning_content ?? null,
  glm: (kwargs) => kwargs?.reasoning_content ?? null,
};

/**
 * 默认提取策略
 *
 * 对未注册的厂商，尝试从 reasoning_content 提取（OpenAI 兼容格式的通用位置）。
 */
const DEFAULT_EXTRACTOR: ReasoningExtractFn = (kwargs) =>
  kwargs?.reasoning_content ?? null;

/**
 * 推理字段归一化服务
 *
 * 核心职责：
 * 将 LangChain AIMessage / AIMessageChunk 的原始输出归一化为统一的
 * NormalizedChatOutput 结构，使上层业务代码无需关心厂商差异。
 *
 * 使用场景：
 * 1. 非流式 (invoke)：从完整的 AIMessage 中一次性提取 content 和 reasoning
 * 2. 流式 (stream)：  从每个 AIMessageChunk 中逐片判断并分类
 *
 * 设计决策：
 * - 采用策略模式而非 if-else，便于独立扩展各厂商的提取逻辑
 * - 未注册的厂商会回退到默认策略，保证前向兼容
 * - 同时处理 string 和 ContentPart[] 两种 content 格式（兼容多模态）
 */
@Injectable()
export class ReasoningNormalizer {
  private readonly logger = new Logger(ReasoningNormalizer.name);

  /**
   * 从 LangChain 模型输出中提取并归一化推理字段
   *
   * @param provider   厂商标识（如 'deepseek', 'qwen'）
   * @param rawOutput  LangChain 模型的原始输出（AIMessage 或 AIMessageChunk）
   * @returns 归一化后的输出，content 和 reasoning 已分离
   */
  normalize(
    provider: string,
    rawOutput: Record<string, any>,
  ): NormalizedChatOutput {
    const content = this.extractContent(rawOutput);
    const reasoning = this.extractReasoning(provider, rawOutput);

    return { content, reasoning };
  }

  /**
   * 仅提取推理内容
   *
   * 适用于流式场景中只需判断当前 chunk 是否携带推理数据。
   *
   * @param provider   厂商标识
   * @param rawOutput  LangChain AIMessageChunk
   * @returns 推理文本，无推理数据时返回 null
   */
  extractReasoning(
    provider: string,
    rawOutput: Record<string, any>,
  ): string | null {
    const extractor = REASONING_EXTRACTORS[provider] ?? DEFAULT_EXTRACTOR;
    const additionalKwargs = rawOutput?.additional_kwargs ?? {};

    try {
      return extractor(additionalKwargs);
    } catch (error) {
      this.logger.warn(
        `从 ${provider} 输出中提取推理字段失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * 提取主文本内容
   *
   * LangChain 的 content 字段存在两种形态：
   * - string：普通文本消息
   * - ContentPart[]：多模态消息（图文混合），此处仅提取文本部分
   */
  private extractContent(rawOutput: Record<string, any>): string {
    const content = rawOutput?.content;

    if (typeof content === 'string') {
      return content;
    }

    // 多模态消息：content 为 ContentPart 数组，仅提取 text 类型
    if (Array.isArray(content)) {
      return content
        .filter((part: any) => part?.type === 'text')
        .map((part: any) => part.text ?? '')
        .join('');
    }

    return '';
  }

  /**
   * 检查指定厂商是否已注册推理字段提取策略
   *
   * @param provider 厂商标识
   * @returns 是否有专属的推理提取策略
   */
  isReasoningSupported(provider: string): boolean {
    return provider in REASONING_EXTRACTORS;
  }
}
