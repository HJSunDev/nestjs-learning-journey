import { Injectable, Logger } from '@nestjs/common';
import type { StructuredToolInterface } from '@langchain/core/tools';

import {
  createGetCurrentTimeTool,
  createCalculateTool,
  createGetWeatherTool,
} from './definitions';

/**
 * 工具列表项（面向 API 响应，不含可执行实例）
 */
export interface ToolListItem {
  /** 工具名称（模型调用时的标识） */
  name: string;
  /** 工具描述（模型据此判断何时调用） */
  description: string;
}

/**
 * 工具注册中心
 *
 * 043 章节重构：从自定义 IAiTool 接口迁移到 LangChain 原生 StructuredToolInterface。
 *
 * 设计决策：
 * - 直接存储 LangChain 的 StructuredToolInterface 实例，
 *   可以直接传给 model.bindTools()，无需适配层
 * - 具体工具使用 DynamicStructuredTool + Zod Schema 定义，
 *   参数校验由 Zod 在调用前自动完成
 * - 内置工具在构造时自动注册，外部模块也可通过 register() 扩展
 */
@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, StructuredToolInterface>();

  constructor() {
    this.registerBuiltinTools();
  }

  /**
   * 注册内置工具
   *
   * 在构造函数中调用，将所有预定义的工具注册到注册表中。
   * 工具定义在 definitions/ 目录下，每个工具是一个工厂函数。
   */
  private registerBuiltinTools(): void {
    this.register(createGetCurrentTimeTool());
    this.register(createCalculateTool());
    this.register(createGetWeatherTool());

    this.logger.log(`内置工具注册完成，共 ${this.tools.size} 个可用工具`);
  }

  /**
   * 注册工具
   *
   * @param tool LangChain StructuredToolInterface 实例
   */
  register(tool: StructuredToolInterface): void {
    if (this.tools.has(tool.name)) {
      this.logger.warn(`工具 "${tool.name}" 已存在，将被覆盖`);
    }
    this.tools.set(tool.name, tool);
    this.logger.log(`工具注册成功: ${tool.name}`);
  }

  /**
   * 批量注册工具
   *
   * @param tools 工具实例列表
   */
  registerMany(tools: StructuredToolInterface[]): void {
    tools.forEach((tool) => this.register(tool));
  }

  /**
   * 注销工具
   *
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
   *
   * @param name 工具名称
   */
  get(name: string): StructuredToolInterface | undefined {
    return this.tools.get(name);
  }

  /**
   * 检查工具是否存在
   *
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
   * 获取指定工具的 LangChain 实例列表
   *
   * 返回的数组可直接传给 model.bindTools(tools)。
   * 未指定名称时返回所有已注册工具。
   *
   * @param names 工具名称列表，为空则返回所有
   */
  getTools(names?: string[]): StructuredToolInterface[] {
    const targetNames = names ?? this.getNames();
    return targetNames
      .map((name) => this.tools.get(name))
      .filter((tool): tool is StructuredToolInterface => tool !== undefined);
  }

  /**
   * 获取工具列表信息（面向 API 响应）
   *
   * @param names 工具名称列表，为空则返回所有
   */
  listTools(names?: string[]): ToolListItem[] {
    const tools = this.getTools(names);
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));
  }

  /**
   * 执行工具
   *
   * 委托给 LangChain 工具实例的 invoke 方法，
   * Zod Schema 会在调用前自动校验参数。
   *
   * @param name 工具名称
   * @param args 调用参数
   * @returns 工具执行结果（字符串）
   */
  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(
        `工具 "${name}" 不存在，可用工具: ${this.getNames().join(', ')}`,
      );
    }

    this.logger.debug(`执行工具: ${name}`, args);
    const startTime = Date.now();

    try {
      const result: unknown = await tool.invoke(args);
      const elapsed = Date.now() - startTime;
      this.logger.debug(`工具执行完成: ${name}, 耗时 ${elapsed}ms`);

      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (error) {
      this.logger.error(`工具执行失败: ${name}`, error);
      // 将错误信息作为工具结果返回给模型，让模型决定如何处理
      const message = error instanceof Error ? error.message : String(error);
      return `工具 "${name}" 执行出错: ${message}`;
    }
  }

  /**
   * 获取已注册工具数量
   */
  get size(): number {
    return this.tools.size;
  }
}
