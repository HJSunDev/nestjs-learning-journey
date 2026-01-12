import { Injectable, Inject, UnauthorizedException, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UserService } from '../user/user.service';
import { HashingService } from '../common/hashing/hashing.service';
import { LoginDTO, RegisterDTO, UserInfoDto, TokensDto } from './dto/auth.dto';
import type { ITokenStorageService } from './token-storage';
import { TOKEN_STORAGE_SERVICE, parseExpiresInToSeconds } from './token-storage';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly hashingService: HashingService,
    private readonly configService: ConfigService,
    @Inject(TOKEN_STORAGE_SERVICE)
    private readonly tokenStorage: ITokenStorageService,
  ) {}

  async info(id: string): Promise<UserInfoDto> {
    
    const user = await this.userService.findOne(id);
    if (!user) {
      throw new NotFoundException('用户不存在');
    }

    return {
      id: user.id,
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

    // 生成双 Token 并存储 Refresh Token 哈希到 Redis
    const tokens = await this.getTokens(newUser.id, newUser.phoneNumber);
    await this.storeRefreshToken(newUser.id, tokens.refresh_token);
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

    // 生成双 Token 并存储 Refresh Token 哈希到 Redis
    const tokens = await this.getTokens(user.id, user.phoneNumber);
    await this.storeRefreshToken(user.id, tokens.refresh_token);
    return tokens;
  }

  /**
   * 使用 Refresh Token 换取新的 Access Token
   * @param userId 用户 ID (从 JwtRefreshStrategy 解析得到)
   * @param refreshToken 原始 Refresh Token 字符串
   */
  async refreshTokens(userId: string, refreshToken: string): Promise<TokensDto> {
    // 从 Redis 获取存储的哈希值
    const storedHash = await this.tokenStorage.get(userId);
    
    // Token 不存在（已登出或已过期）
    if (!storedHash) {
      throw new ForbiddenException('访问被拒绝');
    }

    // 比对传入的 Token 与 Redis 中的哈希值
    const isRefreshTokenValid = await this.hashingService.compare(refreshToken, storedHash);

    if (!isRefreshTokenValid) {
      throw new ForbiddenException('Refresh Token 无效');
    }

    // 获取用户信息用于生成新 Token
    const user = await this.userService.findOne(userId);
    if (!user) {
      throw new ForbiddenException('用户不存在');
    }

    // 签发新的双 Token 并更新 Redis 中的哈希（Token 轮换）
    const tokens = await this.getTokens(userId, user.phoneNumber);
    await this.storeRefreshToken(userId, tokens.refresh_token);
    return tokens;
  }

  /**
   * 用户登出，从 Redis 删除 Refresh Token
   * 即使 Token 未过期，也无法再用于刷新
   */
  async logout(userId: string): Promise<void> {
    await this.tokenStorage.delete(userId);
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
   * 将 Refresh Token 哈希后存入 Redis
   * 存储哈希而非原文，防止 Redis 数据泄露时 Token 被直接利用
   * TTL 与 JWT 过期时间保持一致，实现自动清理
   */
  private async storeRefreshToken(userId: string, refreshToken: string): Promise<void> {
    const hashedToken = await this.hashingService.hash(refreshToken);
    const expiresIn = this.configService.get<string>('jwt.refreshExpiresIn') ?? '7d';
    const ttlSeconds = parseExpiresInToSeconds(expiresIn);
    
    await this.tokenStorage.set(userId, hashedToken, ttlSeconds);
  }
}



