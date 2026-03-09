import { Injectable } from '@nestjs/common';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Runnable } from '@langchain/core/runnables';
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
 * - 042: 在管道末端追加 OutputParser → prompt.pipe(model).pipe(parser)
 * - 043: 通过 .bindTools() 挂载工具 → prompt.pipe(modelWithTools)
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
}
