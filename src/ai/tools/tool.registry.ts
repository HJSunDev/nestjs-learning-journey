import { Injectable, Logger } from '@nestjs/common';


import { IAiTool, ToolDefinition } from '../interfaces';

/**
 * 工具注册中心
 *
 * 负责管理所有可供 AI 调用的工具
 * - 注册/注销工具
 * - 按名称获取工具
 * - 批量获取工具定义（供 AI SDK 使用）
 */
@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, IAiTool>();

  /**
   * 注册工具
   * @param tool 工具实例
   */
  register(tool: IAiTool): void {
    if (this.tools.has(tool.name)) {
      this.logger.warn(`工具 "${tool.name}" 已存在，将被覆盖`);
    }
    this.tools.set(tool.name, tool);
    this.logger.log(`工具注册成功: ${tool.name}`);
  }

  /**
   * 批量注册工具
   * @param tools 工具实例列表
   */
  registerMany(tools: IAiTool[]): void {
    tools.forEach((tool) => this.register(tool));
  }

  /**
   * 注销工具
   * @param name 工具名称
   */
  unregister(name: string): boolean {
    const result = this.tools.delete(name);
    if (result) {
      this.logger.log(`工具注销成功: ${name}`);
    }
    return result;
  }

  /**
   * 获取工具实例
   * @param name 工具名称
   */
  get(name: string): IAiTool | undefined {
    return this.tools.get(name);
  }

  /**
   * 检查工具是否存在
   * @param name 工具名称
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 获取所有已注册的工具名称
   */
  getNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * 获取指定工具的定义列表
   * 用于传递给 AI SDK
   * @param names 工具名称列表，为空则返回所有
   */
  getDefinitions(names?: string[]): ToolDefinition[] {
    const targetNames = names ?? this.getNames();
    return targetNames
      .map((name) => this.tools.get(name))
      .filter((tool): tool is IAiTool => tool !== undefined)
      .map((tool) => tool.getDefinition());
  }

  /**
   * 执行工具
   * @param name 工具名称
   * @param args 调用参数
   * @param context 执行上下文
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    context?: Record<string, unknown>,
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`工具 "${name}" 不存在`);
    }

    this.logger.debug(`执行工具: ${name}`, args);
    const startTime = Date.now();

    try {
      const result = await tool.execute(args, context);
      this.logger.debug(
        `工具执行完成: ${name}, 耗时 ${Date.now() - startTime}ms`,
      );
      return result;
    } catch (error) {
      this.logger.error(`工具执行失败: ${name}`, error);
      throw error;
    }
  }

  /**
   * 获取已注册工具数量
   */
  get size(): number {
    return this.tools.size;
  }
}
