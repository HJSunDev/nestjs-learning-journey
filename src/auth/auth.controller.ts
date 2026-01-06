import { Controller, Post, Body, HttpCode, HttpStatus, Get, Request, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDTO, RegisterDTO, UserInfoDto, TokensDto } from './dto/auth.dto';
import { Public } from '../common/decorators/public.decorator';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';

@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public() // 公开接口，无需登录
  @ApiOperation({ summary: '用户注册' })
  @ApiResponse({ status: 201, type: TokensDto, description: '注册成功，返回双 Token' })
  @Post('register')
  async register(@Body() registerDto: RegisterDTO): Promise<TokensDto> {
    return this.authService.register(registerDto);
  }

  @Public() // 公开接口，无需登录
  @ApiOperation({ summary: '用户登录' })
  @ApiResponse({ status: 200, type: TokensDto, description: '登录成功，返回双 Token' })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() loginDto: LoginDTO): Promise<TokensDto> {
    return this.authService.login(loginDto);
  }

  @ApiBearerAuth() // Swagger 文档标记需要 Bearer Token
  @ApiOperation({ summary: '获取当前用户信息' })
  @ApiResponse({ status: 200, type: UserInfoDto })
  @Get('info')
  async info(@Request() req: any): Promise<UserInfoDto> {
    return this.authService.info(req.user.id);
  }

  /**
   * 使用 Refresh Token 换取新的 Access Token
   * 前端在 Access Token 过期(401)后调用此接口实现无感刷新
   */
  @Public() // 绕过全局 JwtAuthGuard，由 JwtRefreshGuard 单独保护
  @UseGuards(JwtRefreshGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '刷新 Token' })
  @ApiResponse({ status: 200, type: TokensDto, description: '刷新成功，返回新的双 Token' })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Request() req: any): Promise<TokensDto> {
    // req.user 由 JwtRefreshStrategy.validate 返回，包含 id 和 refreshToken
    return this.authService.refreshTokens(req.user.id, req.user.refreshToken);
  }

  /**
   * 用户登出
   * 清除服务端存储的 Refresh Token 哈希，使其无法再用于刷新
   */
  @ApiBearerAuth()
  @ApiOperation({ summary: '用户登出' })
  @ApiResponse({ status: 200, description: '登出成功' })
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Request() req: any): Promise<{ message: string }> {
    await this.authService.logout(req.user.id);
    return { message: '登出成功' };
  }
}
