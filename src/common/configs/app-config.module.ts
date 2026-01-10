import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as Joi from 'joi';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      // 1. 强校验：确保 .env 文件中必须存在某些变量，且格式正确
      validationSchema: Joi.object({
        APP_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
        APP_PORT: Joi.number().default(3000),
        // 数据库配置校验 (PostgreSQL)
        DB_HOST: Joi.string().required(),
        DB_PORT: Joi.number().default(5432),
        DB_NAME: Joi.string().required(),
        DB_USER: Joi.string().allow('').optional(),
        DB_PASS: Joi.string().allow('').optional(),
        DB_SYNCHRONIZE: Joi.boolean().default(false),
        DB_LOGGING: Joi.boolean().default(false),
        // 日志配置
        LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly').default('info'),
        LOG_ON_CONSOLE: Joi.boolean().default(true),
        // 文件存储配置
        STORAGE_DRIVER: Joi.string().valid('local', 'oss').default('local'),
        STORAGE_LOCAL_DIR: Joi.string().allow('').optional(),
        STORAGE_LOCAL_PREFIX: Joi.string().default('/static/upload'),
        // JWT 双 Token 配置
        JWT_ACCESS_SECRET: Joi.string().required(),
        JWT_ACCESS_EXPIRES_IN: Joi.string().default('15m'),
        JWT_REFRESH_SECRET: Joi.string().required(),
        JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),
        // Redis 配置
        REDIS_HOST: Joi.string().default('localhost'),
        REDIS_PORT: Joi.number().default(6379),
        REDIS_PASSWORD: Joi.string().allow('').optional(),
        REDIS_DB: Joi.number().default(0),
      }),
      // 2. 结构化与类型转换：将扁平的 env 字符串转换为结构化对象，方便在代码中使用
      load: [() => ({
        env: process.env.APP_ENV,
        port: parseInt(process.env.APP_PORT || '3000', 10),
        database: {
          host: process.env.DB_HOST,
          port: parseInt(process.env.DB_PORT || '5432', 10),
          name: process.env.DB_NAME,
          user: process.env.DB_USER,
          pass: process.env.DB_PASS,
          synchronize: process.env.DB_SYNCHRONIZE === 'true',
          logging: process.env.DB_LOGGING === 'true',
        },
        logger: {
          level: process.env.LOG_LEVEL,
          onConsole: process.env.LOG_ON_CONSOLE === 'true',
        },
        storage: {
          driver: process.env.STORAGE_DRIVER || 'local',
          local: {
            dir: process.env.STORAGE_LOCAL_DIR || 'static/upload',
            prefix: process.env.STORAGE_LOCAL_PREFIX || '/static/upload',
          },
          // OSS 配置预留
          oss: {
            region: process.env.STORAGE_OSS_REGION,
            bucket: process.env.STORAGE_OSS_BUCKET,
            accessKeyId: process.env.STORAGE_OSS_ACCESS_KEY_ID,
            accessKeySecret: process.env.STORAGE_OSS_ACCESS_KEY_SECRET,
          },
        },
        jwt: {
          accessSecret: process.env.JWT_ACCESS_SECRET,
          accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
          refreshSecret: process.env.JWT_REFRESH_SECRET,
          refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
        },
        redis: {
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT || '6379', 10),
          password: process.env.REDIS_PASSWORD,
          db: parseInt(process.env.REDIS_DB || '0', 10),
        },
      })],
    }),
  ],
  exports: [ConfigModule],
})
export class AppConfigModule {}

