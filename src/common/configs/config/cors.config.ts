import { registerAs } from '@nestjs/config';

/**
 * CORS 跨域配置
 * 
 * 白名单机制 (环境变量):
 * - CORS_ORIGINS: 允许的来源域名列表 (逗号分隔)
 *   开发环境: http://localhost:5173,http://localhost:3001
 *   生产环境: https://example.com,https://admin.example.com
 * 
 * 业务配置 (代码默认值):
 * - 允许的 HTTP 方法
 * - 允许的请求头
 * - 预检请求缓存时间
 */
export default registerAs('cors', () => {
  // 解析白名单域名列表
  const originsString = process.env.CORS_ORIGINS || '';
  const origins = originsString
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  return {
    // 白名单域名列表
    origins,
    
    // 允许的 HTTP 方法
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    
    // 允许的请求头
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    
    // 允许浏览器读取的响应头
    exposedHeaders: ['Content-Disposition'],
    
    // 是否允许携带凭证 (Cookie, Authorization Header)
    credentials: true,
    
    // 预检请求缓存时间 (秒) - 24 小时
    maxAge: 86400,
  };
});
