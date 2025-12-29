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
        // 数据库配置校验
        DB_HOST: Joi.string().required(),
        DB_PORT: Joi.number().default(27017),
        DB_NAME: Joi.string().required(),
        DB_USER: Joi.string().allow('').optional(),
        DB_PASS: Joi.string().allow('').optional(),
        DB_AUTH_SOURCE: Joi.string().default('admin'),
        DB_SYNCHRONIZE: Joi.boolean().default(false),
        DB_LOGGING: Joi.boolean().default(false),
        // 日志配置
        LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly').default('info'),
        LOG_ON_CONSOLE: Joi.boolean().default(true),
      }),
      // 2. 结构化与类型转换：将扁平的 env 字符串转换为结构化对象，方便在代码中使用
      load: [() => ({
        env: process.env.APP_ENV,
        port: parseInt(process.env.APP_PORT || '3000', 10),
        database: {
          host: process.env.DB_HOST,
          port: parseInt(process.env.DB_PORT || '27017', 10),
          name: process.env.DB_NAME,
          user: process.env.DB_USER,
          pass: process.env.DB_PASS,
          authSource: process.env.DB_AUTH_SOURCE,
          synchronize: process.env.DB_SYNCHRONIZE === 'true',
          logging: process.env.DB_LOGGING === 'true',
        },
        logger: {
          level: process.env.LOG_LEVEL,
          onConsole: process.env.LOG_ON_CONSOLE === 'true',
        },
      })],
    }),
  ],
  exports: [ConfigModule],
})
export class AppConfigModule {}

