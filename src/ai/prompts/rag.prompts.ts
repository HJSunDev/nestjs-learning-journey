import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from '@langchain/core/prompts';

/**
 * RAG 系统提示词
 *
 * 指导模型基于检索到的上下文回答问题，而非依赖训练数据中的知识。
 * 核心约束：
 * - 仅基于提供的上下文作答，避免幻觉
 * - 当上下文不足以回答时，明确告知用户
 * - 引用来源信息，增强可信度
 */
const RAG_SYSTEM_TEMPLATE = `你是一个专业的知识库问答助手。请严格基于以下检索到的上下文内容回答用户的问题。

规则：
1. 只使用下方"参考资料"中的信息来回答，不要依赖你的训练数据
2. 如果参考资料中没有相关信息，请明确回复"根据现有知识库，我没有找到相关信息"
3. 回答时尽可能引用具体来源
4. 保持回答简洁、准确、有条理

参考资料：
{context}`;

/**
 * 构建 RAG 对话的提示模板
 *
 * 组合结构：SystemMessage(RAG 指令 + {context}) → HumanMessage('{question}')
 *
 * 与 createQuickChatPrompt 的差异：
 * - 固定使用 RAG 系统提示词（包含 {context} 占位符）
 * - {context} 在运行时由检索器注入相关文档内容
 * - 可选传入自定义系统提示词追加到 RAG 指令之后
 *
 * @param customSystemPrompt 可选的额外系统指令（追加到 RAG 指令之后）
 * @returns ChatPromptTemplate 实例，输入变量：{ context: string, question: string }
 */
export function createRagPrompt(
  customSystemPrompt?: string,
): ChatPromptTemplate {
  const systemContent = customSystemPrompt
    ? `${RAG_SYSTEM_TEMPLATE}\n\n附加指令：${customSystemPrompt}`
    : RAG_SYSTEM_TEMPLATE;

  return ChatPromptTemplate.fromMessages([
    ['system', systemContent],
    ['human', '{question}'],
  ]);
}

/**
 * 构建带历史记录的 RAG 对话提示模板
 *
 * 组合结构：SystemMessage(RAG 指令 + {context}) → MessagesPlaceholder('history') → HumanMessage('{question}')
 *
 * 在 RAG 基础上增加多轮对话能力，用于需要上下文连续性的场景
 * （如用户追问"详细说说第三点"时需要知道之前聊过什么）。
 *
 * @param customSystemPrompt 可选的额外系统指令
 * @returns ChatPromptTemplate 实例，输入变量：{ context, history, question }
 */
export function createRagMemoryPrompt(
  customSystemPrompt?: string,
): ChatPromptTemplate {
  const systemContent = customSystemPrompt
    ? `${RAG_SYSTEM_TEMPLATE}\n\n附加指令：${customSystemPrompt}`
    : RAG_SYSTEM_TEMPLATE;

  return ChatPromptTemplate.fromMessages([
    ['system', systemContent],
    new MessagesPlaceholder('history'),
    ['human', '{question}'],
  ]);
}
