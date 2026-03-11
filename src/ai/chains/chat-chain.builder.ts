import { Injectable } from '@nestjs/common';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Runnable } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { ZodObject, ZodRawShape } from 'zod';
import { convertToLangChainMessages } from '../utils';
import {
  createChatPrompt,
  createQuickChatPrompt,
  hasSystemMessage,
} from '../prompts';
import type { Message } from '../interfaces';

/**
 * LCEL 链的预组装结果
 *
 * 将 chain（可执行管道）和 input（管道输入）打包返回，
 * 调用方无需关心链的内部输入结构，直接 chain.invoke(input) 或 chain.stream(input)。
 */
export interface PreparedChain {
  /** LCEL 可执行链（prompt → model 管道） */
  chain: Runnable;
  /** 预组装的链输入（模板变量 → 值的映射） */
  input: Record<string, unknown>;
}

/**
 * 对话链构建器
 *
 * 041 章节的核心产物。封装 LCEL 管道的组装逻辑，
 * 将提示模板（ChatPromptTemplate）与模型（BaseChatModel）组合为可执行链。
 *
 * 职责边界：
 * - 本层只负责"组装"（prompt + model → chain）和"准备输入"（messages → chainInput）
 * - 不负责模型创建（由 AiModelFactory 负责）
 * - 不负责结果归一化（由 ReasoningNormalizer 负责）
 * - 不负责流式分发（由 LcelService.executeStream 负责）
 *
 * 设计要点：
 * - 返回 PreparedChain 而非裸 Runnable，调用方无需了解链的输入结构
 * - 内部调用 convertToLangChainMessages 进行消息转换，与 Service 层解耦
 * - 同一条链既可 invoke() 也可 stream()，消除非流式/流式的代码分化
 *
 * 扩展方向：
 * - 042: 通过 withStructuredOutput 包装模型 → prompt.pipe(structuredModel)
 * - 043: 通过 .bindTools() 挂载工具 → prompt.pipe(modelWithTools)
 *        完整的工具调用循环（多轮迭代）由 ToolCallingLoop 负责
 * - 046: 通过 .withRetry() 追加重试 → chain.withRetry({ stopAfterAttempt: 3 })
 */
@Injectable()
export class ChatChainBuilder {
  /**
   * 构建多轮对话 LCEL 管道
   *
   * 管道结构：ChatPromptTemplate([SystemMessage?], MessagesPlaceholder) → Model
   *
   * 提示模板层接管了 systemPrompt 的注入逻辑，遵循与 convertToLangChainMessages
   * 相同的合并策略：当 messages 中已含 system 角色消息时，忽略 systemPrompt。
   *
   * @param model         由 AiModelFactory 创建的 LangChain 模型实例
   * @param messages      项目内部消息列表（DTO 层的 MessageDto[]）
   * @param systemPrompt  可选的系统提示词
   * @returns PreparedChain，调用方直接 chain.invoke(input) 或 chain.stream(input)
   */
  buildChatChain(
    model: BaseChatModel,
    messages: Message[],
    systemPrompt?: string,
  ): PreparedChain {
    const prompt = createChatPrompt(systemPrompt, hasSystemMessage(messages));

    return {
      chain: prompt.pipe(model),
      input: { messages: convertToLangChainMessages(messages) },
    };
  }

  /**
   * 构建单轮快速对话 LCEL 管道
   *
   * 管道结构：ChatPromptTemplate([SystemMessage?], '{input}') → Model
   *
   * 与多轮对话链不同，此链使用 '{input}' 模板变量直接接收用户文本，
   * 无需将用户输入预先构造为 MessageDto 数组再转换为 BaseMessage[]。
   *
   * @param model         由 AiModelFactory 创建的 LangChain 模型实例
   * @param userInput     用户输入文本
   * @param systemPrompt  可选的系统提示词
   * @returns PreparedChain，调用方直接 chain.invoke(input)
   */
  buildQuickChatChain(
    model: BaseChatModel,
    userInput: string,
    systemPrompt?: string,
  ): PreparedChain {
    const prompt = createQuickChatPrompt(systemPrompt);

    return {
      chain: prompt.pipe(model),
      input: { input: userInput },
    };
  }

  /**
   * 构建多轮对话 + 结构化输出 LCEL 管道
   *
   * 管道结构：ChatPromptTemplate → model.withStructuredOutput(schema)
   *
   * withStructuredOutput 返回一个新的 Runnable，其输出不再是 AIMessage，
   * 而是经 Zod Schema 校验后的强类型 JSON 对象。内部使用 tool calling
   * 或 JSON mode（取决于模型能力）来约束输出格式。
   *
   * 设置 includeRaw: true 使返回值变为 { raw: AIMessage, parsed: T }，
   * 从而可同时获取结构化数据和 token usage 等运行时元数据。
   *
   * @param model         由 AiModelFactory 创建的 LangChain 模型实例
   * @param schema        Zod Schema，定义期望的输出结构
   * @param messages      项目内部消息列表
   * @param systemPrompt  可选的系统提示词
   * @returns PreparedChain，chain.invoke(input) 返回 { raw, parsed }
   */
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

  /**
   * 构建单轮快速提取 + 结构化输出 LCEL 管道
   *
   * 管道结构：ChatPromptTemplate([SystemMessage?], '{input}') → model.withStructuredOutput(schema)
   *
   * 适用于从一段文本中提取结构化信息的单轮场景（如情感分析、实体提取）。
   *
   * @param model         由 AiModelFactory 创建的 LangChain 模型实例
   * @param schema        Zod Schema，定义期望的输出结构
   * @param userInput     用户输入文本
   * @param systemPrompt  可选的系统提示词
   * @returns PreparedChain，chain.invoke(input) 返回 { raw, parsed }
   */
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

  /**
   * 构建工具调用 LCEL 管道
   *
   * 管道结构：ChatPromptTemplate → model.bindTools(tools)
   *
   * model.bindTools() 将工具定义注入到模型的请求参数中，
   * 模型在推理时可以选择调用一个或多个工具（返回 tool_calls），
   * 也可以直接返回文本（不调用工具）。
   *
   * 此方法构建的是"单次调用"链——仅触发一次模型推理。
   * 完整的工具调用循环（模型调用工具 → 执行 → 回传结果 → 再推理）
   * 由 ToolCallingLoop 负责编排。
   *
   * @param model         由 AiModelFactory 创建的 LangChain 模型实例
   * @param tools         要绑定的 LangChain 工具实例列表
   * @param messages      项目内部消息列表
   * @param systemPrompt  可选的系统提示词
   * @returns PreparedChain，chain.invoke(input) 返回 AIMessage（可能含 tool_calls）
   */
  buildToolCallingChain(
    model: BaseChatModel,
    tools: StructuredToolInterface[],
    messages: Message[],
    systemPrompt?: string,
  ): PreparedChain {
    if (typeof model.bindTools !== 'function') {
      throw new Error('当前模型不支持 bindTools 方法，无法构建工具调用链。');
    }

    const prompt = createChatPrompt(systemPrompt, hasSystemMessage(messages));
    const modelWithTools = model.bindTools(tools);

    return {
      chain: prompt.pipe(modelWithTools),
      input: { messages: convertToLangChainMessages(messages) },
    };
  }
}
