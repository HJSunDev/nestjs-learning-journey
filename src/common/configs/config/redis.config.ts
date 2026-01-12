import { registerAs } from '@nestjs/config';

/**
 * Redis 配置
 * 
 * 敏感信息 (必须从环境变量读取):
 * - REDIS_HOST, REDIS_PORT, REDIS_PASSWORD
 * 
 * 可选配置:
 * - REDIS_DB: 数据库索引 (默认 0)
 */
export default registerAs('redis', () => ({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  /**
   * Redis 数据库索引。
   * 
   * Redis 支持在同一个实例下划分多个逻辑数据库，以数值 0 ~ N 标识，默认为 0。
   * 不同数据库间的数据是相互隔离的，可以用作简单的数据区分或分环境部署。
   * 通过设置环境变量 REDIS_DB 可指定使用的数据库编号，未设置则默认为 0。
   * 
   * 这里通过 parseInt 解析字符串为整数，确保类型正确传递给 Redis 客户端。
   */
  db: parseInt(process.env.REDIS_DB || '0', 10),
}));
