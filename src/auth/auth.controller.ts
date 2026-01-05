import { Controller, Post, Body, HttpCode, HttpStatus, Get, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDTO, RegisterDTO, UserInfoDto } from './dto/auth.dto';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public() // 公开接口，无需登录
  @ApiOperation({ summary: '用户注册' })
  @Post('register')
  async register(@Body() registerDto: RegisterDTO) {
    return this.authService.register(registerDto);
  }

  @Public() // 公开接口，无需登录
  @ApiOperation({ summary: '用户登录' })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginDto: LoginDTO) {
    return this.authService.login(loginDto);
  }

  @ApiBearerAuth() // Swagger 文档标记需要 Bearer Token
  @ApiOperation({ summary: '获取当前用户信息' })
  @ApiResponse({ type: UserInfoDto })
  @Get('info')
  async info(@Request() req: any) {
    // req.user 由 JwtStrategy.validate 返回
    return this.authService.info(req.user.id);
  }
}


