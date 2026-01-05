import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

// @Public() 装饰器，用于标记无需 JWT 认证的接口
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

