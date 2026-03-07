import { ChatDeepSeek } from '@langchain/deepseek';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type {
  IProviderAdapter,
  AdapterModelParams,
} from './provider-adapter.interface';

/**
 * OpenAI 兼容协议适配器
 *
 * 适用于所有遵循 OpenAI Chat Completions API 规范的厂商，
 * 包括：DeepSeek、Qwen（通义千问）、Moonshot（Kimi）、GLM（智谱）、SiliconFlow（硅基流动）。
 *
 * 内部使用 ChatDeepSeek 而非 ChatOpenAI 的原因（EXP-001 / EXP-003）：
 * ChatOpenAI 的消息转换函数使用白名单机制，会静默丢弃 reasoning_content 推理字段。
 * ChatDeepSeek 重写了 _convertCompletionsMessageToBaseMessage() 方法，
 * 通过 (message as any).reasoning_content 从原始响应中正确保留该字段。
 * 这一行为不依赖任何 DeepSeek 特有的 API 约定，仅利用了其更完整的字段提取逻辑。
 *
 * 若未来 @langchain/openai 修复了 reasoning_content 丢失问题（GitHub Issue #9663），
 * 可将此处的 ChatDeepSeek 替换为 ChatOpenAI，只需改动这一个文件。
 */
export class OpenAICompatibleAdapter implements IProviderAdapter {
  createModel(params: AdapterModelParams): BaseChatModel {
    return new ChatDeepSeek({
      apiKey: params.apiKey,
      model: params.model,
      temperature: params.temperature,
      streaming: params.streaming,
      maxTokens: params.maxTokens,
      ...(params.modelKwargs ? { modelKwargs: params.modelKwargs } : {}),
      ...(params.baseUrl ? { configuration: { baseURL: params.baseUrl } } : {}),
    });
  }
}
