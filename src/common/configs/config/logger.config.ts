import { registerAs } from '@nestjs/config';

/**
 * 日志配置
 * 
 * 环境变量 (可选覆盖):
 * - LOG_LEVEL: 日志级别 (error | warn | info | http | verbose | debug | silly)
 * - LOG_ON_CONSOLE: 是否在控制台输出日志
 * 
 * 业务配置 (代码默认值):
 * - 开发环境: info 级别，控制台输出
 * - 生产环境: warn 级别，关闭控制台
 */
export default registerAs('logger', () => {
  const isProduction = process.env.APP_ENV === 'production';
  
  return {
    // 日志级别 (生产环境默认 warn，开发环境默认 info)
    level: process.env.LOG_LEVEL || (isProduction ? 'warn' : 'info'),
    
    // 是否在控制台输出 (生产环境默认关闭)
    onConsole: process.env.LOG_ON_CONSOLE !== undefined
      ? process.env.LOG_ON_CONSOLE === 'true'
      : !isProduction,
  };
});
