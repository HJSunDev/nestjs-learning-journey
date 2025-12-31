import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UserModule } from './user/user.module';
import { RoleModule } from './role/role.module';
import { AppConfigModule } from './common/configs/app-config.module';
import { LoggerModule } from './common/logger/logger.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';

@Module({
  imports: [
    AppConfigModule, // 全局配置模块，一旦导入，所有其他模块都能直接用 ConfigService
    LoggerModule,    // 全局日志模块
    // 数据库连接配置
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      // useFactory 返回的这个对象，就是 TypeORM 的标准 DataSourceOptions 接口
      // NestJS 会将此对象直接透传给 TypeORM 核心库，用于建立数据库连接 (相当于 new DataSource(options))
      useFactory: (configService: ConfigService) => {
        const dbConfig = configService.get('database');
        return {
          type: 'mongodb',
          host: dbConfig.host,
          port: dbConfig.port,
          username: dbConfig.user,
          password: dbConfig.pass,
          database: dbConfig.name,
          authSource: dbConfig.authSource, 
          autoLoadEntities: true, // 自动加载通过 forFeature 注册的实体，无需手动配置 entities 路径
          synchronize: dbConfig.synchronize, // MongoDB 只有在 v3 驱动下才完全支持 synchronize，通常生产环境建议设为 false
          logging: dbConfig.logging, // 是否打印数据库操作日志
          // useUnifiedTopology: true, // 已废弃：自 MongoDB Driver 4.0.0 起，useUnifiedTopology 选项已被移除且不再生效，配置会出现警告信息
        };
      },
    }),
    UserModule,
    RoleModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
