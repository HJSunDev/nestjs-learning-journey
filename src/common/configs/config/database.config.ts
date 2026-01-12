import { registerAs } from '@nestjs/config';

/**
 * 数据库配置 (PostgreSQL)
 * 
 * 敏感信息 (必须从环境变量读取):
 * - DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS
 * 
 * 行为配置 (可选环境变量覆盖):
 * - DB_SYNCHRONIZE: 是否自动同步表结构 (生产环境必须为 false)
 * - DB_LOGGING: 是否开启 SQL 日志
 */
export default registerAs('database', () => ({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  name: process.env.DB_NAME,
  user: process.env.DB_USER,
  pass: process.env.DB_PASS,
  
  // 是否自动同步表结构 (生产环境强制关闭)
  synchronize: process.env.APP_ENV === 'production' 
    ? false 
    : process.env.DB_SYNCHRONIZE === 'true',
  
  // 是否开启 SQL 日志
  logging: process.env.DB_LOGGING === 'true',
}));
