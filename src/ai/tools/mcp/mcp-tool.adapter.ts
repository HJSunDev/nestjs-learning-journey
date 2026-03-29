import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MultiServerMCPClient } from '@langchain/mcp-adapters';
import type { Connection } from '@langchain/mcp-adapters';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { ToolRegistry } from '../tool.registry';

/**
 * MCP 服务器连接配置
 */
export interface McpServerConfig {
  /** 服务器名称（用于工具名称前缀和日志标识） */
  name: string;
  /** 传输协议 */
  transport: 'stdio' | 'http';
  /** HTTP 端点 URL（transport=http 时必填） */
  url?: string;
  /** 命令行工具路径（transport=stdio 时必填） */
  command?: string;
  /** 命令行参数（transport=stdio 时） */
  args?: string[];
  /** 环境变量（transport=stdio 时传递给子进程） */
  env?: Record<string, string>;
}

/**
 * MCP 工具适配器
 *
 * 将 Model Context Protocol (MCP) 服务器的工具无缝集成到现有的 ToolRegistry 体系中，
 * 使 Agent 可以像使用内置工具一样使用任意 MCP 服务器提供的工具。
 *
 * 核心价值：
 * - MCP 是 LLM 工具生态的开放标准（Anthropic 发起，已被主流平台采纳）
 * - 通过 @langchain/mcp-adapters 将 MCP 工具转换为 LangChain StructuredTool
 * - 转换后的工具自动注册到 ToolRegistry，对上层 Agent 透明
 *
 * 架构决策：
 * - 适配器在模块初始化时连接 MCP 服务器并注册工具（OnModuleInit）
 * - 模块销毁时自动关闭连接（OnModuleDestroy）
 * - 连接失败不阻塞应用启动（静默跳过，记录警告）
 * - 工具名称加服务器前缀（避免不同 MCP 服务器的工具名冲突）
 */
@Injectable()
export class McpToolAdapter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpToolAdapter.name);
  private client: MultiServerMCPClient | null = null;

  /** 记录已注册的 MCP 工具名称，用于模块销毁时注销 */
  private readonly registeredToolNames: string[] = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly toolRegistry: ToolRegistry,
  ) {}

  async onModuleInit(): Promise<void> {
    const enabled = this.configService.get<boolean>('ai.mcp.enabled', false);
    if (!enabled) {
      this.logger.log('MCP 工具适配已禁用 (AI_MCP_ENABLED=false)');
      return;
    }

    await this.connectAndRegister();
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  /**
   * 连接所有配置的 MCP 服务器并将其工具注册到 ToolRegistry
   *
   * 从环境变量读取 MCP 服务器配置（JSON 格式），
   * 通过 MultiServerMCPClient 建立连接，获取工具并注册。
   */
  private async connectAndRegister(): Promise<void> {
    const serversJson = this.configService.get<string>('ai.mcp.servers', '{}');

    let serverConfigs: Record<string, unknown>;
    try {
      serverConfigs =
        typeof serversJson === 'string'
          ? (JSON.parse(serversJson) as Record<string, unknown>)
          : (serversJson as Record<string, unknown>);
    } catch {
      this.logger.warn('MCP 服务器配置解析失败，请检查 AI_MCP_SERVERS 格式');
      return;
    }

    if (Object.keys(serverConfigs).length === 0) {
      this.logger.debug('未配置 MCP 服务器');
      return;
    }

    try {
      this.client = new MultiServerMCPClient(
        serverConfigs as Record<string, Connection>,
      );

      const tools = await this.client.getTools();
      this.registerTools(tools as StructuredToolInterface[]);

      this.logger.log(
        `MCP 工具加载完成: ${tools.length} 个工具已注册到 ToolRegistry`,
      );
    } catch (error) {
      this.logger.error(
        `MCP 服务器连接失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 将 MCP 工具注册到 ToolRegistry
   *
   * @param tools - MCP 适配器返回的 LangChain 工具列表
   */
  private registerTools(tools: StructuredToolInterface[]): void {
    for (const tool of tools) {
      this.toolRegistry.register(tool);
      this.registeredToolNames.push(tool.name);
      this.logger.debug(`MCP 工具已注册: ${tool.name}`);
    }
  }

  /**
   * 断开所有 MCP 服务器连接并注销已注册的工具
   */
  private async disconnect(): Promise<void> {
    // 注销 MCP 工具
    for (const name of this.registeredToolNames) {
      this.toolRegistry.unregister(name);
    }
    this.registeredToolNames.length = 0;

    // 关闭 MCP 客户端连接
    if (this.client) {
      try {
        await this.client.close();
        this.logger.log('MCP 客户端连接已关闭');
      } catch (error) {
        this.logger.warn(
          `MCP 客户端关闭出错: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.client = null;
    }
  }

  /**
   * 动态加载单个 MCP 服务器的工具（运行时扩展）
   *
   * 支持在应用运行期间动态连接新的 MCP 服务器，
   * 无需重启应用即可扩展 Agent 的工具能力。
   *
   * @param config - MCP 服务器配置
   * @returns 已注册的工具名称列表
   *
   * @example
   * // 参数示例
   * const config = { name: 'weather', transport: 'http', url: 'http://localhost:3001/mcp' };
   *
   * // 调用示例
   * const toolNames = await mcpAdapter.loadServer(config);
   *
   * // 返回值示例
   * // ['weather_get_forecast', 'weather_get_current']
   */
  async loadServer(config: McpServerConfig): Promise<string[]> {
    const connection: Record<string, unknown> =
      config.transport === 'http'
        ? { transport: 'http', url: config.url }
        : {
            transport: 'stdio',
            command: config.command,
            args: config.args,
            env: config.env,
          };

    const tempClient = new MultiServerMCPClient({
      [config.name]: connection as Connection,
    });

    try {
      const tools = await tempClient.getTools();
      this.registerTools(tools as StructuredToolInterface[]);
      this.logger.log(
        `动态加载 MCP 服务器 "${config.name}": ${tools.length} 个工具`,
      );
      return tools.map((t) => t.name);
    } catch (error) {
      this.logger.error(
        `动态加载 MCP 服务器 "${config.name}" 失败: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * 获取已注册的 MCP 工具名称列表
   */
  getRegisteredToolNames(): string[] {
    return [...this.registeredToolNames];
  }
}
