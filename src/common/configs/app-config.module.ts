import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as Joi from 'joi';
import { configurations } from './config';

/**
 * 全局配置模块
 * 
 * 架构设计：
 * 1. 敏感信息 → 从环境变量读取 (validationSchema 校验)
 * 2. 业务配置 → 在配置文件中定义默认值 (config/*.config.ts)
 * 3. 环境覆盖 → 配置文件中可选读取环境变量覆盖默认值
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      
      // 加载所有配置文件 (使用 registerAs 创建的命名空间配置)
      load: configurations,
      
      // 环境变量校验：只校验必须从环境变量提供的敏感信息
      validationSchema: Joi.object({
        // === 应用基础 ===
        APP_ENV: Joi.string()
          .valid('development', 'production', 'test')
          .default('development'),
        APP_PORT: Joi.number().default(3000),
        
        // === 数据库 (敏感) ===
        DB_HOST: Joi.string().required(),
        DB_PORT: Joi.number().default(5432),
        DB_NAME: Joi.string().required(),
        DB_USER: Joi.string().allow('').optional(),
        DB_PASS: Joi.string().allow('').optional(),
        
        // === Redis (敏感) ===
        REDIS_HOST: Joi.string().default('localhost'),
        REDIS_PORT: Joi.number().default(6379),
        REDIS_PASSWORD: Joi.string().allow('').optional(),
        
        // === JWT (敏感) ===
        JWT_ACCESS_SECRET: Joi.string().required(),
        JWT_REFRESH_SECRET: Joi.string().required(),
        
        // === 可选覆盖项 (非敏感，有默认值) ===
        DB_SYNCHRONIZE: Joi.boolean().optional(),
        DB_LOGGING: Joi.boolean().optional(),
        REDIS_DB: Joi.number().optional(),
        JWT_ACCESS_EXPIRES_IN: Joi.string().optional(),
        JWT_REFRESH_EXPIRES_IN: Joi.string().optional(),
        LOG_LEVEL: Joi.string().optional(),
        LOG_ON_CONSOLE: Joi.boolean().optional(),
        STORAGE_DRIVER: Joi.string().valid('local', 'oss').optional(),
        STORAGE_LOCAL_DIR: Joi.string().optional(),
        STORAGE_LOCAL_PREFIX: Joi.string().optional(),
        CORS_ORIGINS: Joi.string().optional(),
      }),
    }),
  ],
  exports: [ConfigModule],
})
export class AppConfigModule {}

