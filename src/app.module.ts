import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UserModule } from './user/user.module';
import { RoleModule } from './role/role.module';
import { UploadModule } from './upload/upload.module';
import { AuthModule } from './auth/auth.module';
import { AppConfigModule } from './common/configs/app-config.module';
import { LoggerModule } from './common/logger/logger.module';
import { RedisModule } from './common/redis/redis.module';
import { HealthModule } from './common/health/health.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { TypeOrmLogger } from './common/logger/typeorm-logger';

@Module({
  imports: [
    AppConfigModule, // 全局配置模块，一旦导入，所有其他模块都能直接用 ConfigService
    LoggerModule,    // 全局日志模块
    RedisModule,     // Redis 模块 (Global)
    // 速率限制模块 (Global)
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        errorMessage: '当前请求过于频繁，请稍后再试', // 自定义错误信息
        throttlers: [
          {
            ttl: 60000, // 默认窗口 60 秒
            limit: 60,  // 默认限制 60 次请求 (1 QPS)
          },
        ],
        // 使用 Redis 存储计数器，实现分布式限流
        storage: new ThrottlerStorageRedisService({
          host: config.get('redis.host'),
          port: config.get('redis.port'),
          password: config.get('redis.password'),
          db: config.get('redis.db'),
        }),
      }),
    }),
    // 数据库连接配置 (PostgreSQL)
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      // useFactory 返回的这个对象，就是 TypeORM 的标准 DataSourceOptions 接口
      // NestJS 会将此对象直接透传给 TypeORM 核心库，用于建立数据库连接 (相当于 new DataSource(options))
      useFactory: (configService: ConfigService) => {
        const dbConfig = configService.get('database');
        return {
          type: 'postgres',
          host: dbConfig.host,
          port: dbConfig.port,
          username: dbConfig.user,
          password: dbConfig.pass,
          database: dbConfig.name,
          autoLoadEntities: true, // 自动加载通过 forFeature 注册的实体，无需手动配置 entities 路径
          synchronize: dbConfig.synchronize, // 是否自动同步数据库结构 (开发环境建议开启，生产环境建议关闭)
          
          // 使用自定义 Logger 接管 TypeORM 日志
          logger: new TypeOrmLogger(),
          // 策略控制：
          // 1. 如果 env 中 DB_LOGGING=true，则记录所有操作('all')。
          //    注意：此时具体是否打印，还取决于全局 LOG_LEVEL。
          //    例如 SQL 是 debug 级别，如果 LOG_LEVEL=info，则依然看不见 SQL。
          // 2. 如果 env 中 DB_LOGGING=false，则仅记录错误和警告(['error', 'warn'])。
          logging: dbConfig.logging ? 'all' : ['error', 'warn'],
        };
      },
    }),
    UserModule,
    RoleModule,
    UploadModule,
    AuthModule,
    HealthModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // 注册全局限流守卫
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
