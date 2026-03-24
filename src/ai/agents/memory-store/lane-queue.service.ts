import { Injectable, Logger } from '@nestjs/common';

/**
 * 泳道（车道）队列服务
 * Lane Queue 服务 — 按 Thread 维度的串行执行队列
 *
 * 解决什么问题：
 * 在生产环境中，同一 threadId 的多个并发请求可能导致：
 * 1. Checkpoint 写入竞争：两次 invoke 同时读取同一 checkpoint 并写回，
 *    后写入的覆盖先写入的，导致状态丢失
 * 2. 消息乱序：并发写入的消息顺序不可预测
 * 3. Store 写入冲突：同时提取和存储记忆可能产生重复条目
 *
 * 设计方案：
 * - 每个 threadId 维护一条 Promise 链（Lane），新请求挂到链尾
 * - 不同 threadId 之间完全并行（不同用户的对话不互相阻塞）
 * - 使用 FinalizationRegistry 或定期清理释放已完成 Lane 的引用
 *
 * 名称来源：
 * "Lane"（车道）隐喻 — 每个 thread 有自己的独立车道，
 * 同车道内的请求排队通过，不同车道互不干扰。
 *
 * 适用范围：
 * - Graph invoke/stream 调用
 * - HITL resume 操作
 * - 任何需要按 threadId 串行化的操作
 */
@Injectable()
export class LaneQueueService {
  private readonly logger = new Logger(LaneQueueService.name);

  /**
   * threadId → Promise chain 映射
   *
   * 每个 threadId 对应一条"车道"，车道内的任务严格串行。
   * Promise 链在最后一个任务完成后被清理（防止内存泄漏）。
   */
  private readonly lanes = new Map<string, Promise<unknown>>();

  /** 活跃的 Lane 计数（监控用） */
  private activeLaneCount = 0;

  /**
   * 将任务加入指定 thread 的串行队列
   *
   * 如果该 thread 当前没有正在执行的任务，立即执行；
   * 否则排在上一个任务之后，等上一个完成再执行。
   *
   * @param threadId - 线程标识
   * @param fn - 待执行的异步任务
   * @returns 任务的执行结果
   * @throws 透传任务本身抛出的异常（不影响队列中后续任务的执行）
   *
   * @example
   * // 参数示例
   * const threadId = 'thread-abc';
   * const task = async () => graph.invoke(input, config);
   *
   * // 调用示例
   * const result = await laneQueueService.enqueue(threadId, task);
   *
   * // 返回值示例
   * // 任务 fn 的返回值
   */
  async enqueue<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const isNewLane = !this.lanes.has(threadId);
    const currentLane = this.lanes.get(threadId) ?? Promise.resolve();

    // 将新任务挂到 Promise 链尾部
    // 使用 .catch(() => {}) 确保前一个任务的失败不阻塞后续任务
    const newLane = currentLane
      .catch(() => {
        /* 前序任务的异常已由各自的 caller 处理，此处忽略以保持链条连续 */
      })
      .then(() => fn());

    this.lanes.set(threadId, newLane);

    if (isNewLane) {
      this.activeLaneCount++;
    }

    try {
      return await newLane;
    } finally {
      // 如果当前 Promise 仍是链尾（没有新任务追加），清理该 Lane
      if (this.lanes.get(threadId) === newLane) {
        this.lanes.delete(threadId);
        this.activeLaneCount = Math.max(0, this.activeLaneCount - 1);
      }
    }
  }

  /**
   * 获取当前活跃的 Lane 数量（健康检查/监控用）
   */
  getActiveLaneCount(): number {
    return this.lanes.size;
  }

  /**
   * 检查指定 thread 是否有任务在排队
   *
   * @param threadId - 线程标识
   * @returns 是否有活跃的 Lane
   */
  isThreadBusy(threadId: string): boolean {
    return this.lanes.has(threadId);
  }
}
