import { Injectable, UnauthorizedException } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';

/**
 * Refresh Token 验证策略
 * 从请求中提取原始 Token 并附加到 payload，供 Service 层校验数据库哈希
 */
@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {

  constructor(private readonly configService: ConfigService) {
    super({
      // 从请求头 Authorization: Bearer <token> 中提取 Refresh Token
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // 使用 Refresh Token 专用密钥
      secretOrKey: configService.get<string>('jwt.refreshSecret')!,
      // 是否忽略过期检查 (false = 不忽略，过期会报错)
      ignoreExpiration: false,
      // 将 Request 对象传递给 validate 方法，以便提取原始 Refresh Token
      passReqToCallback: true,
    });
  }

  /**
   * Token 签名验证通过后调用
   * @param req Express Request 对象, 用于提取原始完整 Refresh Token
   * @param payload 解码后的 Refresh Token 内容
   * @returns 附加了原始 refreshToken 的用户信息，挂载到 req.user
   */
  async validate(req: Request, payload: any) {
    // 从 Header 中提取原始的 Refresh Token（未解码的完整字符串）
    const refreshToken = req.get('Authorization')?.replace('Bearer ', '').trim();

    // 如果提取不到 Refresh Token，抛出 401 错误
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh Token 缺失');
    }

    // 返回值会被挂载到 req.user
    // 原始 Refresh Token 用于在 Service 层与数据库中的哈希值进行比对
    return {
      id: payload.id,
      mobile: payload.mobile,
      refreshToken,
    };
  }
}

