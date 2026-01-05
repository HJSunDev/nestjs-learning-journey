import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  
  constructor(private readonly configService: ConfigService) {
    super({
      // 从请求头 Authorization: Bearer <token> 中提取 JWT
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // 验证 token 签名的密钥 使用非空断言 !
      secretOrKey: configService.get<string>('jwt.secret')!,
      // 是否忽略过期检查 (false = 不忽略，过期会报错)
      ignoreExpiration: false, 
    });
  }

  // validate 方法在 token 验证通过后自动调用
  // payload 是解码后的 token 内容
  async validate(payload: any) {
    // 返回值会被自动挂载到 req.user
    return {
      id: payload.id,
      mobile: payload.mobile
    };
  }
}

