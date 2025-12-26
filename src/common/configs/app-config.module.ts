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
        DB_URL: Joi.string().required(),
        DB_NAME: Joi.string().required(),
        DB_USER: Joi.string().required(),
        DB_PASS: Joi.string().required(),
        DB_SYNCHRONIZE: Joi.boolean().default(false),
        DB_LOGGING: Joi.boolean().default(false),
      }),
      // 2. 结构化与类型转换：将扁平的 env 字符串转换为结构化对象，方便在代码中使用
      load: [() => ({
        env: process.env.APP_ENV,
        port: parseInt(process.env.APP_PORT || '3000', 10),
        database: {
          url: process.env.DB_URL,
          name: process.env.DB_NAME,
          user: process.env.DB_USER,
          pass: process.env.DB_PASS,
          synchronize: process.env.DB_SYNCHRONIZE === 'true',
          logging: process.env.DB_LOGGING === 'true',
        },
      })],
    }),
  ],
  exports: [ConfigModule],
})
export class AppConfigModule {}

