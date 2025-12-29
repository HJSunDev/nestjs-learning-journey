import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WinstonModule, utilities as nestWinstonModuleUtilities } from 'nest-winston';
import * as winston from 'winston';
import 'winston-daily-rotate-file';

@Module({
  imports: [
    WinstonModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const loggerConfig = configService.get('logger');
        const transports: winston.transport[] = [];

        // 1. 控制台输出 (开发环境常用)
        if (loggerConfig.onConsole) {
          transports.push(
            new winston.transports.Console({
              format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.ms(),
                nestWinstonModuleUtilities.format.nestLike('NestJourney', {
                  colors: true,
                  prettyPrint: true,
                }),
              ),
            }),
          );
        }

        // 2. 文件输出 (按天轮转)
        // 错误日志 - 只记录 error 级别
        transports.push(
          new winston.transports.DailyRotateFile({
            level: 'error',
            dirname: 'logs',
            filename: 'error-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true, // 归档时压缩
            maxSize: '20m', // 单个文件最大尺寸
            maxFiles: '14d', // 保留最近 14 天的日志
            format: winston.format.combine(
              winston.format.timestamp(),
              winston.format.json(),
            ),
          }),
        );

        // 组合日志 - 记录所有级别的日志 (info, warn, error 等)
        transports.push(
          new winston.transports.DailyRotateFile({
            dirname: 'logs',
            filename: 'combined-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d',
            format: winston.format.combine(
              winston.format.timestamp(),
              winston.format.json(),
            ),
          }),
        );

        return {
          // 全局日志级别 (Root Level): 
          // 这是日志进入 Winston 管道的第一道关卡。
          // 只有级别 <= 此设置的日志，才会被分发给下方的 transports。
          // 例如：如果此处设为 'info'，那么 'debug' 级别的日志在分发前就会被丢弃，
          // 此时即使 transport 中没有设置 level 或设置了 'debug' 也无效。
          level: loggerConfig.level,
          transports,
        };
      },
    }),
  ],
  exports: [WinstonModule],
})
export class LoggerModule {}

