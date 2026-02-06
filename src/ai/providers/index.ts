/**
 * Provider 层说明
 *
 * AI 模型的提供商适配由 LangChain 的官方/社区包直接提供：
 * - @langchain/deepseek   → ChatDeepSeek
 * - @langchain/community  → ChatAlibabaTongyi, ChatMoonshot, ChatZhipuAI
 *
 * AiModelFactory 直接实例化上述 LangChain 类，因此无需自行实现 Provider 类。
 * 此目录预留给可能的自定义 Provider 扩展（如需包装 LangChain 不支持的厂商）。
 */
