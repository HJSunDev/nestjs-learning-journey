import { Injectable } from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { HashingService } from '../common/hashing/hashing.service';

@Injectable()
export class UserService {
  constructor(private readonly hashingService: HashingService) {}

  async create(createUserDto: CreateUserDto) {
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
    return `This action returns a #${id} user`;
  }

  update(id: number, updateUserDto: UpdateUserDto) {
    return `This action updates a #${id} user`;
  }

  remove(id: number) {
    return `This action removes a #${id} user`;
  }
}
