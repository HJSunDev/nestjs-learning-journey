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
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Module({
  imports: [
    UserModule,
    HashingModule,
    PassportModule, // 注册 Passport 模块
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>('jwt.secret'),
        signOptions: { 
            expiresIn: configService.get('jwt.expiresIn') 
        },
      }),
    }),
  ],
  providers: [
    AuthService, 
    JwtStrategy, // 注册 JWT 策略
    {
      provide: APP_GUARD, // 注册全局 Guard
      useClass: JwtAuthGuard,
    }
  ],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}


