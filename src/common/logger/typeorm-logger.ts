import { Logger as NestLogger } from '@nestjs/common';
import { Logger as ITypeOrmLogger, QueryRunner } from 'typeorm';

/**
 * 自定义 TypeORM 日志适配器
 * 
 * 作用：将 TypeORM 的原生日志（直接 console.log）桥接到 NestJS 的统一 Logger 系统中。
 * 优势：
 * 1. 统一格式：SQL 日志也遵循 JSON/Winston 格式
 * 2. 统一存储：SQL 日志会自动进入 logs/ 文件夹
 * 3. 灵活级别：普通 SQL 使用 debug 级别，生产环境可以通过调整全局 LOG_LEVEL 来决定是否记录
 */
export class TypeOrmLogger implements ITypeOrmLogger {
  // 使用 NestJS 的 Logger，上下文命名为 'TypeORM'
  private readonly logger = new NestLogger('TypeORM');

  /**
   * 记录普通查询
   * 映射级别: debug (开发环境可见，生产环境通常 info 级别不可见)
   */
  logQuery(query: string, parameters?: any[], queryRunner?: QueryRunner) {
    // 只有当参数存在且不为空时才拼接参数，保持日志整洁
    const params = parameters && parameters.length ? ` -- PARAMETERS: ${JSON.stringify(parameters)}` : '';
    this.logger.debug(`${query}${params}`);
  }

  /**
   * 记录执行失败的查询
   * 映射级别: error
   */
  logQueryError(error: string | Error, query: string, parameters?: any[], queryRunner?: QueryRunner) {
    const params = parameters && parameters.length ? ` -- PARAMETERS: ${JSON.stringify(parameters)}` : '';
    this.logger.error(`${query}${params} -- ERROR: ${error}`);
  }

  /**
   * 记录执行缓慢的查询
   * 映射级别: warn
   */
  logQuerySlow(time: number, query: string, parameters?: any[], queryRunner?: QueryRunner) {
    const params = parameters && parameters.length ? ` -- PARAMETERS: ${JSON.stringify(parameters)}` : '';
    this.logger.warn(`Time: ${time}ms -- ${query}${params}`);
  }

  /**
   * 记录 Schema 构建/迁移日志
   * 映射级别: log (info)
   */
  logSchemaBuild(message: string, queryRunner?: QueryRunner) {
    this.logger.log(message);
  }

  /**
   * 记录迁移运行日志
   * 映射级别: log (info)
   */
  logMigration(message: string, queryRunner?: QueryRunner) {
    this.logger.log(message);
  }

  /**
   * 记录普通日志
   * 映射级别: log (info)
   */
  log(level: 'log' | 'info' | 'warn', message: any, queryRunner?: QueryRunner) {
    switch (level) {
      case 'log':
      case 'info':
        this.logger.log(message);
        break;
      case 'warn':
        this.logger.warn(message);
        break;
    }
  }
}
