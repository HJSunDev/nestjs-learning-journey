import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as Joi from 'joi';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true, // 关键：设置为全局模块，这样其他模块不需要再次导入 ConfigModule
      envFilePath: '.env', // 指定环境文件路径
      validationSchema: Joi.object({
        // 核心：使用 Joi 进行强校验，确保环境变量存在且格式正确
        PORT: Joi.number().default(3000),
        DATABASE_HOST: Joi.string().required(),
        DATABASE_PORT: Joi.number().required(),
        API_KEY: Joi.string().required(),
      }),
    }),
  ],
  exports: [ConfigModule], // 导出原始 ConfigModule，虽然 isGlobal: true 不需要显式导出，但作为包装模块这是个好习惯
})
export class AppConfigModule {}

