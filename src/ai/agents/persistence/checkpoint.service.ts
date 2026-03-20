import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import {
  MemorySaver,
  type BaseCheckpointSaver,
} from '@langchain/langgraph-checkpoint';

/**
 * Checkpoint 持久化服务 — 管理 LangGraph Checkpointer 的生命周期
 *
 * 职责：
 * 1. 根据配置决定使用 PostgresSaver（生产）还是 MemorySaver（开发/降级）
 * 2. 在模块初始化时完成表结构迁移（PostgresSaver.setup()）
 * 3. 提供 getCheckpointer() 供 GraphService/ReactService 编译持久化图
 * 4. 在模块销毁时释放数据库连接
 *
 * 设计决策：
 * - 复用项目已有的 PostgreSQL 连接配置，从 ConfigService 构建连接字符串
 * - PostgresSaver 自行管理连接池，不与 TypeORM 共享（避免耦合）
 * - 生产环境使用 PostgresSaver，开发环境可通过 AI_CHECKPOINT_ENABLED=false 降级为 MemorySaver
 */
@Injectable()
export class CheckpointService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CheckpointService.name);

  // 统一的 Checkpointer 接口抽象，作为最终提供给 LangGraph 的图编译参数。
  // 使用基类 BaseCheckpointSaver 声明，是为了将底层存储策略与图的执行逻辑解耦，
  // 从而能无缝在 MemorySaver（降级/开发）与 PostgresSaver（生产）之间平滑切换。
  private checkpointer: BaseCheckpointSaver;

  // 额外保留对 PostgresSaver 的具体类型引用，以便于对底层资源进行精确控制。
  // 因为 PostgresSaver 维护了独立的数据库连接池（未与 TypeORM 共享），
  // 我们必须调用它特有的生命周期方法（如 setup() 建表，end() 释放连接），而这些方法在基类接口中并不存在。
  private postgresSaver: PostgresSaver | null = null;

  /** 标记持久化是否已就绪 */
  private ready = false;

  constructor(private readonly configService: ConfigService) {}

  /**
   * 模块初始化 — 创建并配置 Checkpointer
   *
   * PostgresSaver.setup() 会执行必要的数据库迁移（创建 checkpoint 表），
   * 已存在的表不会被重复创建（幂等操作）。
   */
  async onModuleInit(): Promise<void> {
    // 判断是否启用持久化
    const enabled = this.configService.get<boolean>(
      'ai.checkpoint.enabled',
      true,
    );

    // 如果未启用持久化，则使用 MemorySaver
    if (!enabled) {
      this.checkpointer = new MemorySaver();
      // 标记持久化已就绪
      this.ready = true;
      // 记录日志
      this.logger.log(
        'Checkpoint 持久化已禁用，使用 MemorySaver（内存模式，重启后数据丢失）',
      );
      return;
    }

    // 如果启用持久化，则使用 PostgresSaver
    try {
      // 构建连接字符串
      const connString = this.buildConnectionString();

      // 这里直接使用 fromConnString 实例化，其内部会基于 pg 库创建一个独立的数据库连接池。
      // 我们选择不复用项目全局的 TypeORM 连接池，是为了实现隔离：
      // 1. 隔离高频 I/O 影响：LangGraph 在每次图调度的 super-step 边界都会保存快照，产生极高频的读写。独立连接池能防止持久化操作耗尽业务数据库连接、阻塞正常 API 请求。
      // 2. 避免事务交叉：图引擎的持久化有自己严格的存储逻辑，独立连接可以彻底规避受业务代码中长时间运行事务（TypeORM Transaction）锁竞争或超时配置的负面影响。
      this.postgresSaver = PostgresSaver.fromConnString(connString);
      // 为了确保图执行时底层持久化表（如 checkpoints、checkpoint_writes）已经存在，此处必须提前调用 setup。
      // 该方法具有幂等性，会在表缺失时自动建表，避免运行时因表结构缺失导致写入或恢复状态失败。
      await this.postgresSaver.setup();
      this.checkpointer = this.postgresSaver;
      this.ready = true;
      this.logger.log('PostgresSaver 初始化完成，checkpoint 表结构已就绪');
    } catch (error) {
      this.logger.warn(
        'PostgresSaver 初始化失败，降级为 MemorySaver。' +
          `错误: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.checkpointer = new MemorySaver();
      this.ready = true;
    }
  }

  /**
   * 模块销毁 — 释放 PostgresSaver 的数据库连接池
   */
  async onModuleDestroy(): Promise<void> {
    if (this.postgresSaver) {
      try {
        await this.postgresSaver.end();
        this.logger.log('PostgresSaver 连接池已释放');
      } catch (error) {
        this.logger.warn(
          `PostgresSaver 连接池释放失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * 获取 Checkpointer 实例
   *
   * @returns 当前可用的 BaseCheckpointSaver（PostgresSaver 或 MemorySaver）
   * @throws {Error} 当服务尚未初始化时
   */
  getCheckpointer(): BaseCheckpointSaver {
    if (!this.ready) {
      throw new Error(
        'CheckpointService 尚未初始化，请确保在 onModuleInit 完成后调用',
      );
    }
    return this.checkpointer;
  }

  /**
   * 是否使用生产级持久化（PostgresSaver）
   */
  isPostgresBacked(): boolean {
    return this.postgresSaver !== null && this.ready;
  }

  /**
   * 获取默认持久化模式
   */
  getDefaultDurabilityMode(): 'sync' | 'async' | 'exit' {
    return this.configService.get<'sync' | 'async' | 'exit'>(
      'ai.checkpoint.durabilityMode',
      'sync',
    );
  }

  /**
   * 从项目已有的 数据库配置 构建 PostgreSQL 连接字符串
   *
   * 复用 database.config.ts 中的 DB_HOST/DB_PORT 等环境变量，
   * 避免为 checkpoint 引入独立的数据库连接配置。
   *
   * @returns PostgreSQL 连接字符串，格式: postgresql://user:pass@host:port/dbname
   */
  private buildConnectionString(): string {
    const host = this.configService.get<string>('database.host', 'localhost');
    const port = this.configService.get<number>('database.port', 5432);
    const user = this.configService.get<string>('database.user', 'postgres');
    const pass = this.configService.get<string>('database.pass', '');
    const name = this.configService.get<string>(
      'database.name',
      'nest_journey',
    );

    // encodeURIComponent 处理密码中的特殊字符
    return `postgresql://${user}:${encodeURIComponent(pass)}@${host}:${port}/${name}`;
  }
}
