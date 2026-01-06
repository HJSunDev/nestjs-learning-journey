import { Injectable, UnauthorizedException, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UserService } from '../user/user.service';
import { HashingService } from '../common/hashing/hashing.service';
import { LoginDTO, RegisterDTO, UserInfoDto, TokensDto } from './dto/auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly hashingService: HashingService,
    private readonly configService: ConfigService,
  ) {}

  async info(id: string): Promise<UserInfoDto> {
    
    const user = await this.userService.findOne(id);
    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    // 转换为 UserInfoDto，去除敏感信息
    return {
      id: user._id.toString(),
      name: user.name,
      phoneNumber: user.phoneNumber ?? '',
      createdAt: user.createdAt
    };
  }

  async register(registerDto: RegisterDTO): Promise<TokensDto> {
    const existingUser = await this.userService.findByPhoneNumber(registerDto.phoneNumber);
    if (existingUser) {
      throw new BadRequestException('该手机号已注册');
    }

    if (registerDto.password !== registerDto.passwordRepeat) {
      throw new BadRequestException('两次输入密码不一致');
    }

    const newUser = await this.userService.create({
      name: registerDto.name,
      password: registerDto.password,
      phoneNumber: registerDto.phoneNumber,
    });

    // 生成双 Token 并存储 Refresh Token 哈希
    const tokens = await this.getTokens(newUser._id.toString(), newUser.phoneNumber);
    await this.updateRefreshTokenHash(newUser._id.toString(), tokens.refresh_token);
    return tokens;
  }

  async login(loginDto: LoginDTO): Promise<TokensDto> {
    const user = await this.userService.findByPhoneNumber(loginDto.phoneNumber);
    if (!user) {
      throw new UnauthorizedException('手机号或密码错误');
    }

    const isPasswordValid = await this.hashingService.compare(loginDto.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('手机号或密码错误');
    }

    // 生成双 Token 并存储 Refresh Token 哈希
    const tokens = await this.getTokens(user._id.toString(), user.phoneNumber);
    await this.updateRefreshTokenHash(user._id.toString(), tokens.refresh_token);
    return tokens;
  }

  /**
   * 使用 Refresh Token 换取新的 Access Token
   * @param userId 用户 ID (从 JwtRefreshStrategy 解析得到)
   * @param refreshToken 原始 Refresh Token 字符串
   */
  async refreshTokens(userId: string, refreshToken: string): Promise<TokensDto> {
    
    const user = await this.userService.findOneWithRefreshToken(userId);
    
    // 用户不存在或 Refresh Token 已被清除（已登出）
    // 空字符串表示用户已登出
    if (!user || !user.currentHashedRefreshToken || user.currentHashedRefreshToken === '') {
      throw new ForbiddenException('访问被拒绝');
    }

    // 比对传入的 Token 与数据库中的哈希值
    const isRefreshTokenValid = await this.hashingService.compare(
      refreshToken,
      user.currentHashedRefreshToken,
    );

    if (!isRefreshTokenValid) {
      throw new ForbiddenException('Refresh Token 无效');
    }

    // 签发新的双 Token 并更新数据库中的哈希
    const tokens = await this.getTokens(userId, user.phoneNumber);
    await this.updateRefreshTokenHash(userId, tokens.refresh_token);
    return tokens;
  }

  /**
   * 用户登出，清除数据库中的 Refresh Token 哈希
   * 即使 Token 未过期，也无法再用于刷新
   */
  async logout(userId: string): Promise<void> {
    await this.userService.updateRefreshToken(userId, null);
  }

  /**
   * 生成 Access Token 和 Refresh Token
   */
  private async getTokens(userId: string, mobile: string | undefined): Promise<TokensDto> {
    const payload = {
      sub: userId,
      id: userId,
      mobile: mobile,
    };

    const [accessToken, refreshToken] = await Promise.all([
      // Access Token: 使用 JwtModule 默认配置
      this.jwtService.signAsync(payload),
      // Refresh Token: 手动指定不同的 secret 和过期时间
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('jwt.refreshSecret'),
        // 去掉泛型以避免 JwtSignOptions 类型不匹配
        expiresIn: this.configService.get('jwt.refreshExpiresIn') ?? '7d',
      }),
    ]);

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
    };
  }

  /**
   * 将 Refresh Token 哈希后存入数据库
   * 存储哈希而非原文，防止数据库泄露时 Token 被直接利用
   */
  private async updateRefreshTokenHash(userId: string, refreshToken: string): Promise<void> {
    const hashedRefreshToken = await this.hashingService.hash(refreshToken);
    await this.userService.updateRefreshToken(userId, hashedRefreshToken);
  }
}


