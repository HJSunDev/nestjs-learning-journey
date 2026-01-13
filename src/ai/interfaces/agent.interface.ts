import { Observable } from 'rxjs';
import { StreamChunk, Message } from './provider.interface';

/**
 * Agent 配置
 */
export interface AgentConfig {
  /** Agent 唯一标识 */
  name: string;
  /** Agent 描述 */
  description: string;
  /** 使用的 AI 提供商 */
  provider: string;
  /** 使用的模型 */
  model: string;
  /** 系统提示词 */
  systemPrompt: string;
  /** 可使用的工具列表 */
  tools?: string[];
  /** 温度参数 */
  temperature?: number;
  /** 最大输出 Token */
  maxTokens?: number;
}

/**
 * Agent 输入
 */
export interface AgentInput {
  /** 用户输入/任务描述 */
  prompt: string;
  /** 对话历史 */
  messages?: Message[];
  /** 执行上下文 */
  context?: Record<string, unknown>;
}

/**
 * Agent 输出
 */
export interface AgentOutput {
  /** 最终响应内容 */
  content: string;
  /** 推理过程（如有） */
  reasoning?: string;
  /** 执行的工具调用记录 */
  toolCalls?: AgentToolCallRecord[];
  /** 执行步骤数 */
  steps: number;
}

/**
 * Agent 工具调用记录
 */
export interface AgentToolCallRecord {
  /** 工具名称 */
  toolName: string;
  /** 调用参数 */
  arguments: Record<string, unknown>;
  /** 执行结果 */
  result: unknown;
  /** 执行耗时 (ms) */
  duration: number;
}

/**
 * 编排结果
 */
export interface OrchestrationResult {
  /** 最终输出 */
  output: string;
  /** 各 Agent 的执行记录 */
  agentResults: AgentExecutionRecord[];
  /** 总耗时 (ms) */
  totalDuration: number;
}

/**
 * Agent 执行记录
 */
export interface AgentExecutionRecord {
  /** Agent 名称 */
  agentName: string;
  /** 输入 */
  input: string;
  /** 输出 */
  output: AgentOutput;
  /** 执行耗时 (ms) */
  duration: number;
}

/**
 * AI Agent 抽象接口
 *
 * Agent 封装了完整的 AI 交互逻辑，包括：
 * - 多轮对话管理
 * - 工具调用循环
 * - 推理过程记录
 */
export interface IAiAgent {
  /**
   * Agent 名称
   */
  readonly name: string;

  /**
   * Agent 描述
   */
  readonly description: string;

  /**
   * Agent 具备的能力标签
   */
  readonly capabilities: string[];

  /**
   * 执行 Agent（非流式）
   * @param input Agent 输入
   * @returns Agent 输出
   */
  execute(input: AgentInput): Promise<AgentOutput>;

  /**
   * 执行 Agent（流式）
   * @param input Agent 输入
   * @returns 流式输出 Observable
   */
  executeStream(input: AgentInput): Observable<StreamChunk>;
}

/**
 * Agent 编排器接口
 *
 * 负责管理多个 Agent 的协作执行
 */
export interface IAgentOrchestrator {
  /**
   * 注册 Agent
   * @param agent Agent 实例
   */
  register(agent: IAiAgent): void;

  /**
   * 获取已注册的 Agent
   * @param name Agent 名称
   */
  get(name: string): IAiAgent | undefined;

  /**
   * 获取所有已注册的 Agent
   */
  getAll(): IAiAgent[];

  /**
   * 顺序执行多个 Agent
   * @param task 初始任务
   * @param agentNames 按顺序执行的 Agent 名称列表
   */
  executeSequential(
    task: string,
    agentNames: string[],
  ): Promise<OrchestrationResult>;

  /**
   * 并行执行多个 Agent
   * @param task 任务描述
   * @param agentNames 并行执行的 Agent 名称列表
   */
  executeParallel(
    task: string,
    agentNames: string[],
  ): Promise<OrchestrationResult>;
}
