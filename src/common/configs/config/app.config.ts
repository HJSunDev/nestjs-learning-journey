import { registerAs } from '@nestjs/config';

/**
 * 应用基础配置
 * 
 * 环境变量：
 * - APP_ENV: 运行环境 (development | production | test)
 * - APP_PORT: 服务端口
 */
export default registerAs('app', () => ({
  // 运行环境
  env: process.env.APP_ENV || 'development',
  
  // 服务端口
  port: parseInt(process.env.APP_PORT || '3000', 10),
  
  // 是否为生产环境 (便捷判断)
  isProduction: process.env.APP_ENV === 'production',
}));
