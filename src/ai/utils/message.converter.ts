import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { MessageRole } from '../constants';
import type { Message } from '../interfaces';

/**
 * 将项目内部的 Message/MessageDto 数组转换为 LangChain BaseMessage 数组
 *
 * 转换规则：
 * - system  → SystemMessage
 * - user    → HumanMessage
 * - assistant → AIMessage
 * - tool    → ToolMessage（需要 toolCallId）
 *
 * 系统消息合并策略：
 * - systemPrompt 是快捷语法糖，与 messages 中的 system 消息互斥合并
 * - 若 messages 中已包含 system 消息，则忽略 systemPrompt，以用户显式构造的为准
 * - 若 messages 中无 system 消息，则使用 systemPrompt 生成一条插入头部
 *
 * @param messages     项目内部消息列表
 * @param systemPrompt 可选的系统提示词（仅当 messages 中无 system 消息时生效）
 * @returns LangChain BaseMessage 数组
 */
export function convertToLangChainMessages(
  messages: Message[],
  systemPrompt?: string,
): BaseMessage[] {
  const result: BaseMessage[] = [];

  const hasSystemInMessages = messages.some(
    (msg) => (msg.role as MessageRole) === MessageRole.SYSTEM,
  );

  if (systemPrompt && !hasSystemInMessages) {
    result.push(new SystemMessage(systemPrompt));
  }

  for (const msg of messages) {
    switch (msg.role as MessageRole) {
      case MessageRole.SYSTEM:
        result.push(new SystemMessage(msg.content));
        break;
      case MessageRole.USER:
        result.push(new HumanMessage(msg.content));
        break;
      case MessageRole.ASSISTANT:
        result.push(new AIMessage(msg.content));
        break;
      case MessageRole.TOOL:
        result.push(
          new ToolMessage({
            content: msg.content,
            tool_call_id: msg.toolCallId || '',
          }),
        );
        break;
      default:
        result.push(new HumanMessage(msg.content));
    }
  }

  return result;
}
