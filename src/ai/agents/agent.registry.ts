import { Injectable, Logger } from '@nestjs/common';

/**
 * Agent 注册表
 *
 * 集中管理所有已注册的智能体实例，提供统一的发现和访问入口。
 * 各 Agent 在 NestJS 模块初始化时通过 register() 注册自己，
 * Service 层通过 get() / getOrThrow() 按名称获取并调用。
 *
 * 设计决策：
 * - Map 存储，O(1) 查找性能
 * - 泛型 get<T>() 方法，调用方获得类型安全
 * - 禁止重复注册，避免静默覆盖导致的隐蔽 Bug
 */
@Injectable()
export class AgentRegistry {
  private readonly logger = new Logger(AgentRegistry.name);
  private readonly agents = new Map<string, any>();

  /**
   * 注册一个 Agent 实例
   *
   * @param name  Agent 唯一标识
   * @param agent Agent 实例（通常是封装了 LangGraph CompiledStateGraph 的 Injectable 服务）
   * @throws Error 当同名 Agent 已注册时
   */
  register(name: string, agent: any): void {
    if (this.agents.has(name)) {
      throw new Error(`Agent '${name}' 已注册，不允许重复注册`);
    }
    this.agents.set(name, agent);
    this.logger.log(`已注册 Agent: ${name}`);
  }

  /**
   * 按名称获取 Agent 实例
   *
   * @param name Agent 标识
   * @returns Agent 实例，未找到时返回 undefined
   */
  get<T = any>(name: string): T | undefined {
    return this.agents.get(name) as T | undefined;
  }

  /**
   * 按名称获取 Agent 实例（严格模式）
   *
   * @param name Agent 标识
   * @returns Agent 实例
   * @throws Error 当 Agent 未注册时
   */
  getOrThrow<T = any>(name: string): T {
    const agent = this.agents.get(name);
    if (!agent) {
      throw new Error(
        `Agent '${name}' 未注册，已注册: [${this.getNames().join(', ')}]`,
      );
    }
    return agent as T;
  }

  /**
   * 检查 Agent 是否已注册
   */
  has(name: string): boolean {
    return this.agents.has(name);
  }

  /**
   * 获取所有已注册的 Agent 名称
   */
  getNames(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * 获取已注册 Agent 的数量
   */
  get size(): number {
    return this.agents.size;
  }
}
