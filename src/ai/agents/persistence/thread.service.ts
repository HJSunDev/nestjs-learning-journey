import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import type { BaseMessage } from '@langchain/core/messages';

import type { ToolGraphCompiled } from '../single';

interface GraphSnapshotConfig {
  configurable?: {
    checkpoint_id?: string;
    checkpoint_ns?: string;
  };
}

interface GraphSnapshotMetadata {
  source?: string;
  step?: number;
  writes?: Record<string, unknown> | null;
}

interface GraphStateValues {
  messages?: BaseMessage[];
  toolCallCount?: number;
  iterationCount?: number;
}

interface GraphStateSnapshot {
  values?: GraphStateValues;
  next?: string[];
  metadata?: GraphSnapshotMetadata;
  createdAt?: string;
  config?: GraphSnapshotConfig;
  parentConfig?: GraphSnapshotConfig | null;
}

/**
 * Thread 状态快照 — 序列化后的线程状态（可安全传输到 HTTP 层）
 */
export interface ThreadStateSnapshot {
  /** 线程 ID */
  threadId: string;
  /** Checkpoint ID（唯一标识此快照） */
  checkpointId: string;
  /** Checkpoint 命名空间（子图标识，根图为空字符串） */
  checkpointNs: string;
  /** 当前状态值 */
  values: {
    /** 对话消息列表（序列化格式） */
    messages: SerializedMessage[];
    /** 工具调用总次数 */
    toolCallCount: number;
    /** 当前迭代轮次 */
    iterationCount: number;
  };
  /** 待执行的下一个节点列表（空数组表示图已完成） */
  next: string[];
  /** 元数据 */
  metadata: {
    /** 来源: 'input' | 'loop' | 'update' */
    source: string;
    /** 当前 super-step 编号 */
    step: number;
    /** 节点写入记录 */
    writes: Record<string, unknown> | null;
  };
  /** Checkpoint 创建时间 */
  createdAt: string;
  /** 父 Checkpoint ID（首个 checkpoint 为 null） */
  parentCheckpointId: string | null;
}

/**
 * 序列化后的消息格式 — 用于 HTTP 传输
 */
export interface SerializedMessage {
  /** 消息类型: human | ai | tool | system */
  type: string;
  /** 消息文本内容 */
  content: string;
  /** 工具调用列表（仅 AI 消息） */
  toolCalls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
  /** 工具调用 ID（仅 Tool 消息） */
  toolCallId?: string;
  /** 工具名称（仅 Tool 消息） */
  name?: string;
}

/**
 * Thread Service — 线程生命周期管理与 Time-travel 操作
 *
 * 职责：
 * 1. 生成线程 ID
 * 2. 查询线程当前状态（getState）
 * 3. 查询线程历史 checkpoint 列表（getStateHistory）
 * 4. 从历史 checkpoint 分叉执行（fork）
 * 5. 将 LangGraph StateSnapshot 序列化为 HTTP 可传输格式
 *
 * 设计决策：
 * - 接收编译后的图实例作为方法参数，不直接依赖 GraphService/ReactService（避免循环依赖）
 * - 所有 StateSnapshot → ThreadStateSnapshot 的转换在此层完成
 * - 消息序列化逻辑集中管理，保证 API 一致性
 */
@Injectable()
export class ThreadService {
  private readonly logger = new Logger(ThreadService.name);

  /**
   * 生成新的线程 ID
   *
   * @returns UUID v4 格式的线程标识符
   */
  generateThreadId(): string {
    return uuidv4();
  }

  /**
   * 获取线程当前状态
   *
   * 读取指定线程的最新 checkpoint，返回序列化后的状态快照。
   *
   * @param threadId - 线程 ID
   * @param graph - 编译后的图实例（必须包含 checkpointer）
   * @returns 序列化后的线程状态快照
   * @throws {NotFoundException} 当线程不存在或没有 checkpoint 时
   */
  async getState(
    threadId: string,
    graph: ToolGraphCompiled,
  ): Promise<ThreadStateSnapshot> {
    const config = { configurable: { thread_id: threadId } };

    // graph.getState() 是便捷方法，内部委托给编译时注入的 checkpointer.get()
    // 执行链路: graph.getState(config) → this.checkpointer.get(config) → PostgresSaver/MemorySaver 读取存储
    const snapshot = await graph.getState(config);

    if (!snapshot || !snapshot.config?.configurable?.checkpoint_id) {
      throw new NotFoundException(
        `线程 "${threadId}" 不存在或没有 checkpoint 记录`,
      );
    }

    return this.serializeSnapshot(threadId, snapshot);
  }

  /**
   * 获取线程的完整 checkpoint 历史
   *
   * 返回按时间倒序排列的 checkpoint 列表（最新的在前）。
   * 每个 checkpoint 对应一个 super-step 边界的状态快照。
   *
   * @param threadId - 线程 ID
   * @param graph - 编译后的图实例
   * @param limit - 返回的最大记录数（默认 20）
   * @returns 序列化后的 checkpoint 历史列表
   * @throws {NotFoundException} 当线程没有任何 checkpoint 时
   */
  async getStateHistory(
    threadId: string,
    graph: ToolGraphCompiled,
    limit = 20,
  ): Promise<ThreadStateSnapshot[]> {
    const config = { configurable: { thread_id: threadId } };
    const history: ThreadStateSnapshot[] = [];
    const stateHistory = graph.getStateHistory(
      config,
    ) as AsyncIterable<GraphStateSnapshot>;

    for await (const snapshot of stateHistory) {
      if (history.length >= limit) break;

      const checkpointId = snapshot.config?.configurable?.checkpoint_id;
      if (checkpointId) {
        history.push(this.serializeSnapshot(threadId, snapshot));
      }
    }

    if (history.length === 0) {
      throw new NotFoundException(
        `线程 "${threadId}" 没有 checkpoint 历史记录`,
      );
    }

    return history;
  }

  /**
   * 从历史 checkpoint 分叉 — Time-travel 核心操作
   *
   * 在指定的历史 checkpoint 上创建新的分支，可选地修改状态值。
   * 分叉后在原线程上产生一个新的 checkpoint，后续 invoke 将从分叉点继续。
   *
   * 典型场景：
   * - 回到某个工具调用前的状态，修改参数后重新执行
   * - 从某个决策点探索不同的执行路径
   *
   * @param threadId - 线程 ID
   * @param checkpointId - 要分叉的历史 checkpoint ID
   * @param graph - 编译后的图实例
   * @param values - 可选的状态更新值（通过 reducer 合并到当前状态）
   * @param asNode - 可选，指定此更新被视为来自哪个节点（影响下一个执行的节点）
   * @returns 分叉后的新 checkpoint 配置
   *
   * @example
   * // 参数示例
   * const threadId = '550e8400-e29b-41d4-a716-446655440000';
   * const checkpointId = '1ef663ba-28f9-6ec4-8001-31981c2c39f8';
   *
   * // 调用示例
   * const result = await threadService.fork(threadId, checkpointId, graph);
   *
   * // 返回值示例
   * // { configurable: { thread_id: '...', checkpoint_id: '...' } }
   */
  async fork(
    threadId: string,
    checkpointId: string,
    graph: ToolGraphCompiled,
    values?: Record<string, unknown>,
    asNode?: string,
  ): Promise<{ configurable: Record<string, string> }> {
    const config = {
      configurable: {
        thread_id: threadId,
        checkpoint_id: checkpointId,
      },
    };

    this.logger.log(
      `[Thread] 从 checkpoint ${checkpointId} 分叉线程 ${threadId}`,
    );

    const updateConfig = await graph.updateState(config, values ?? {}, asNode);

    return {
      configurable: updateConfig.configurable as Record<string, string>,
    };
  }

  /**
   * serializeSnapshot 序列化快照
   * 将 LangGraph 图状态快照转为 HTTP 可 JSON 序列化的 `ThreadStateSnapshot`
   *
   * LangGraph 返回的 snapshot 中 `values.messages` 为 `BaseMessage` 类实例，
   * 无法安全 `JSON.stringify` 给客户端；此处统一映射为 `SerializedMessage[]`，
   * 并补齐 checkpoint 元数据字段的缺省值，保证 API 响应结构稳定。
   *
   * @param threadId - 当前查询的线程标识，写入结果顶层供客户端关联
   * @param snapshot - `graph.getState` / `getStateHistory` 返回的单条状态快照（本服务内用 `GraphStateSnapshot` 描述其用到的字段）
   * @returns 含 `threadId`、`checkpointId`、`values`（已扁平消息）、`next`、`metadata`、`createdAt`、`parentCheckpointId` 的快照 DTO
   *
   * @example
   * // 参数示例（snapshot 为 getState 返回值形态，此处仅示意用到的字段）
   * const threadId = '550e8400-e29b-41d4-a716-446655440000';
   * const snapshot = {
   *   values: { messages: [], toolCallCount: 0, iterationCount: 0 },
   *   next: [],
   *   config: { configurable: { checkpoint_id: 'cp-1', checkpoint_ns: '' } },
   *   metadata: { source: 'loop', step: 1, writes: null },
   *   createdAt: '2026-03-19T12:00:00.000Z',
   *   parentConfig: null,
   * };
   *
   * // 调用示例
   * const dto = this.serializeSnapshot(threadId, snapshot);
   *
   * // 返回值示例（messages 已由 BaseMessage 转为 SerializedMessage）
   * // {
   * //   threadId: '550e8400-e29b-41d4-a716-446655440000',
   * //   checkpointId: 'cp-1',
   * //   checkpointNs: '',
   * //   values: { messages: [], toolCallCount: 0, iterationCount: 0 },
   * //   next: [],
   * //   metadata: { source: 'loop', step: 1, writes: null },
   * //   createdAt: '2026-03-19T12:00:00.000Z',
   * //   parentCheckpointId: null,
   * // }
   */
  private serializeSnapshot(
    threadId: string,
    snapshot: GraphStateSnapshot,
  ): ThreadStateSnapshot {
    const values = snapshot.values ?? {};
    const messages = (values.messages as BaseMessage[]) ?? [];

    return {
      threadId,
      checkpointId: snapshot.config?.configurable?.checkpoint_id ?? '',
      checkpointNs: snapshot.config?.configurable?.checkpoint_ns ?? '',
      values: {
        messages: messages.map((msg) => this.serializeMessage(msg)),
        toolCallCount: values.toolCallCount ?? 0,
        iterationCount: values.iterationCount ?? 0,
      },
      next: snapshot.next ?? [],
      metadata: {
        source: snapshot.metadata?.source ?? 'unknown',
        step: snapshot.metadata?.step ?? 0,
        writes: snapshot.metadata?.writes ?? null,
      },
      createdAt: snapshot.createdAt ?? new Date().toISOString(),
      parentCheckpointId:
        snapshot.parentConfig?.configurable?.checkpoint_id ?? null,
    };
  }

  /**
   * serializeMessage 序列化消息
   * 将 LangChain BaseMessage 序列化为纯 JSON 对象
   *
   * @param msg - LangChain 消息实例
   * @returns 序列化后的消息对象
   */
  private serializeMessage(msg: BaseMessage): SerializedMessage {
    // LangChain 1.x 中 _getType()/getType() 已弃用；BaseMessage 上稳定的判别字段是只读 type。
    // 使用 ?? 而非 ||：仅在 null/undefined 时回退为 unknown，避免把空字符串等假值误判为缺失。
    const type = msg.type ?? 'unknown';
    const content =
      typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);

    // 定义序列化后的消息对象，先落全类型共有的基础字段；
    // toolCalls / toolCallId / name 仅在对应消息形态下存在，由下方分支按需追加，避免多处重复拼装整对象。
    const serialized: SerializedMessage = { type, content };

    // 如果消息是 AIMessage，则序列化 tool_calls 字段,因为仅 AIMessage 在模型返回 tool calling 时带有 tool_calls；
    // HumanMessage / ToolMessage 等无此字段，故用 `in` 收窄。
    // {
    //   type: 'ai',
    //   content: '我来查一下',
    //   tool_calls: [{ id: 'call_xxx', name: 'get_weather', args: { city: '北京' } }]
    // }
    if ('tool_calls' in msg && Array.isArray(msg.tool_calls)) {
      const toolCalls = msg.tool_calls as Array<{
        id?: string;
        name: string;
        args: Record<string, unknown>;
      }>;
      if (toolCalls.length > 0) {
        serialized.toolCalls = toolCalls.map((tc) => ({
          id: tc.id ?? '',
          name: tc.name,
          args: tc.args,
        }));
      }
    }

    // 如果消息是 ToolMessage，则序列化 tool_call_id 和 name 字段,因为仅 ToolMessage 在模型返回 tool calling 时带有 tool_call_id 和 name；
    if ('tool_call_id' in msg) {
      serialized.toolCallId = msg.tool_call_id as string;
    }
    if ('name' in msg && typeof msg.name === 'string') {
      serialized.name = msg.name;
    }

    return serialized;
  }
}
