import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Refresh Token 专用守卫
 * 绑定 'jwt-refresh' 策略
 */
@Injectable()
export class JwtRefreshGuard extends AuthGuard('jwt-refresh') {}

