import 'dotenv/config';
import { DataSource, DataSourceOptions } from 'typeorm';

/**
 * TypeORM CLI 专用数据源配置
 *
 * 为什么需要这个文件？
 * - TypeORM CLI (typeorm-ts-node-commonjs) 是一个独立工具，无法读取 NestJS 的 AppModule 配置
 * - 它需要一个导出 DataSource 实例的文件来执行迁移操作
 * - 此文件直接读取 .env 环境变量，与 NestJS 应用配置保持一致
 *
 * 关键路径说明：
 * - entities: 指向编译后的 JS 文件 (dist/)，CLI 运行时需要
 * - migrations: 迁移文件存放位置，生成和运行都使用此路径
 */

const options: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'nest_journey',

  // 实体路径：CLI 运行时需要编译后的 JS 文件
  // NestJS 编译输出到 dist/src/ 目录下
  entities: ['dist/src/**/*.entity.js'],

  // 迁移文件路径
  migrations: ['dist/src/database/migrations/*.js'],

  // 禁用自动同步，使用迁移管理数据库结构
  synchronize: false,

  // 开发环境开启日志，便于调试 SQL
  logging: process.env.DB_LOGGING === 'true',
};

// 导出 DataSource 实例供 TypeORM CLI 使用
export const AppDataSource = new DataSource(options);
