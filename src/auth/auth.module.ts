import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UserModule } from '../user/user.module';
import { HashingModule } from '../common/hashing/hashing.module';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Module({
  imports: [
    UserModule,
    HashingModule,
    PassportModule, // 注册 Passport 模块
    // JwtModule 默认配置服务于 Access Token
    // Refresh Token 的签名在 AuthService 中手动指定 secret
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.accessSecret'),
        signOptions: { 
          // ConfigService 返回 string，需要断言以匹配 JwtModuleOptions 类型
          expiresIn: configService.get('jwt.accessExpiresIn') ?? '15m',
        },
      }),
    }),
  ],
  providers: [
    AuthService, 
    JwtStrategy,        // Access Token 策略
    JwtRefreshStrategy, // Refresh Token 策略
    {
      provide: APP_GUARD, // 注册全局 Guard
      useClass: JwtAuthGuard,
    }
  ],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}


