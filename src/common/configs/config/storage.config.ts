import { registerAs } from '@nestjs/config';

/**
 * 文件存储配置
 * 
 * 驱动选择 (环境变量):
 * - STORAGE_DRIVER: 存储驱动类型 (local | oss)
 * 
 * 本地存储配置 (业务默认值):
 * - 存储目录: static/upload
 * - URL 前缀: /static/upload
 * 
 * OSS 配置 (敏感信息，必须从环境变量读取):
 * - STORAGE_OSS_REGION, STORAGE_OSS_BUCKET, STORAGE_OSS_ACCESS_KEY_ID, STORAGE_OSS_ACCESS_KEY_SECRET
 */
export default registerAs('storage', () => ({
  // 存储驱动: local | oss
  driver: process.env.STORAGE_DRIVER || 'local',
  
  // 本地存储配置
  local: {
    // 存储目录 (相对于项目根目录)
    dir: process.env.STORAGE_LOCAL_DIR || 'static/upload',
    // URL 访问前缀
    prefix: process.env.STORAGE_LOCAL_PREFIX || '/static/upload',
  },
  
  // 阿里云 OSS 配置 (预留)
  oss: {
    region: process.env.STORAGE_OSS_REGION,
    bucket: process.env.STORAGE_OSS_BUCKET,
    accessKeyId: process.env.STORAGE_OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.STORAGE_OSS_ACCESS_KEY_SECRET,
  },
}));
