import { registerAs } from '@nestjs/config';

/**
 * JWT 双 Token 配置
 * 
 * 敏感信息 (必须从环境变量读取):
 * - JWT_ACCESS_SECRET: Access Token 签名密钥
 * - JWT_REFRESH_SECRET: Refresh Token 签名密钥
 * 
 * 业务配置 (代码默认值，可被环境变量覆盖):
 * - JWT_ACCESS_EXPIRES_IN: Access Token 过期时间 (默认 15m)
 * - JWT_REFRESH_EXPIRES_IN: Refresh Token 过期时间 (默认 7d)
 */
export default registerAs('jwt', () => ({
  // Access Token 配置
  accessSecret: process.env.JWT_ACCESS_SECRET,
  accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  
  // Refresh Token 配置
  refreshSecret: process.env.JWT_REFRESH_SECRET,
  refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
}));
