import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserService } from '../user/user.service';
import { HashingService } from '../common/hashing/hashing.service';
import { LoginDTO, RegisterDTO } from './dto/auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly hashingService: HashingService,
  ) {}

  async register(registerDto: RegisterDTO) {
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

    return this.createToken(newUser);
  }

  async login(loginDto: LoginDTO) {
    const user = await this.userService.findByPhoneNumber(loginDto.phoneNumber);
    if (!user) {
      throw new UnauthorizedException('手机号或密码错误');
    }

    const isPasswordValid = await this.hashingService.compare(loginDto.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('手机号或密码错误');
    }

    return this.createToken(user);
  }

  private createToken(user: any) {
    const payload = { id: user._id.toString(), mobile: user.phoneNumber };
    return {
      access_token: this.jwtService.sign(payload),
    };
  }
}


