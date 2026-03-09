import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from '@langchain/core/prompts';
import { SystemMessage } from '@langchain/core/messages';
import { MessageRole } from '../constants';
import type { Message } from '../interfaces';

/**
 * 构建多轮对话的提示模板
 *
 * 组合结构：[SystemMessage?] → MessagesPlaceholder('messages')
 *
 * 系统提示词使用 SystemMessage 实例而非模板字符串 ['system', '{var}']，
 * 防止用户输入中的大括号被 LangChain 误解析为模板变量（模板注入防御）。
 *
 * @param systemPrompt        可选的系统提示词文本
 * @param hasSystemInMessages 消息列表中是否已包含 system 角色消息
 * @returns ChatPromptTemplate 实例，输入变量：{ messages: BaseMessage[] }
 */
export function createChatPrompt(
  systemPrompt?: string,
  hasSystemInMessages: boolean = false,
): ChatPromptTemplate {
  const parts: Parameters<typeof ChatPromptTemplate.fromMessages>[0] = [];

  if (systemPrompt && !hasSystemInMessages) {
    parts.push(new SystemMessage(systemPrompt));
  }

  parts.push(new MessagesPlaceholder('messages'));

  return ChatPromptTemplate.fromMessages(parts);
}

/**
 * 构建单轮快速对话的提示模板
 *
 * 组合结构：[SystemMessage?] → HumanMessage('{input}')
 *
 * 与多轮对话模板不同，此模板使用 '{input}' 模板变量接收用户输入，
 * 无需将用户消息预先转换为 BaseMessage。
 *
 * @param systemPrompt 可选的系统提示词文本
 * @returns ChatPromptTemplate 实例，输入变量：{ input: string }
 */
export function createQuickChatPrompt(
  systemPrompt?: string,
): ChatPromptTemplate {
  const parts: Parameters<typeof ChatPromptTemplate.fromMessages>[0] = [];

  if (systemPrompt) {
    parts.push(new SystemMessage(systemPrompt));
  }

  parts.push(['human', '{input}']);

  return ChatPromptTemplate.fromMessages(parts);
}

/**
 * 检查消息列表中是否包含 system 角色消息
 *
 * 与 convertToLangChainMessages 中的同类检查一致。
 * 在 LCEL 链构建器中用于决定是否需要将 systemPrompt 注入提示模板：
 * 当消息列表中已存在 system 消息时，DTO 的 systemPrompt 字段应被忽略，
 * 以用户显式构造的消息为准。
 *
 * @param messages 项目内部消息列表
 * @returns 是否包含 system 角色消息
 */
export function hasSystemMessage(messages: Message[]): boolean {
  return messages.some(
    (msg) => (msg.role as MessageRole) === MessageRole.SYSTEM,
  );
}
