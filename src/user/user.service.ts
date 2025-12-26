import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { HashingService } from '../common/hashing/hashing.service';

@Injectable()
export class UserService {
  constructor(
    private readonly hashingService: HashingService,
    private readonly configService: ConfigService, // 👈 注入 ConfigService
  ) {}

  async create(createUserDto: CreateUserDto) {
    // 演示读取环境变量
    // 旧代码：const dbHost = this.configService.get<string>('DATABASE_HOST');
    // 新代码：读取新的 database.url 配置项
    const dbUrl = this.configService.get<string>('database.url');
    console.log(`[DEBUG] Connecting to DB with URL length: ${dbUrl?.length}...`);

    // 使用共享模块 HashingService 对密码进行加密
    const hashedPassword = await this.hashingService.hash(createUserDto.password);

    // 在实际业务中，这里会调用 Repository 保存数据
    // const user = await this.userRepository.save({
    //   ...createUserDto,
    //   password: hashedPassword,
    // });

    return {
      action: 'This action adds a new user',
      originalEmail: createUserDto.email,
      hashedPassword: hashedPassword, // 返回哈希后的密码仅供演示
    };
  }

  findAll() {
    return `This action returns all user`;
  }

  findOne(id: number) {
    // 模拟场景：ID 为 999 的用户不存在
    if (id === 999) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }
    return `This action returns a #${id} user`;
  }

  update(id: number, updateUserDto: UpdateUserDto) {
    return `This action updates a #${id} user`;
  }

  remove(id: number) {
    return `This action removes a #${id} user`;
  }
}
