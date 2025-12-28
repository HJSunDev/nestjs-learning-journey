import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ObjectId } from 'mongodb';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { HashingService } from '../common/hashing/hashing.service';
import { User } from './entities/user.mongo.entity';

@Injectable()
export class UserService {
  // 构造函数注入：依赖注入的核心
  constructor(
    // @InjectRepository(User): 是一个装饰器，告诉 NestJS "请给我 User 实体的仓库"
    // Repository<User>: TypeORM 提供的泛型类，里面内置了 find, save, delete 等几十种操作数据库的方法
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly hashingService: HashingService,
  ) {}

  async create(createUserDto: CreateUserDto) {
    // 使用共享模块 HashingService 对密码进行加密
    const hashedPassword = await this.hashingService.hash(createUserDto.password);
    
    // this.userRepository.create(): 
    // 这是一个纯内存操作。它接收普通对象(DTO)，返回一个 User 实体对象。
    // 此时数据还没有存入数据库！它的作用是确保对象符合 Entity 的定义。
    const newUser = this.userRepository.create({
      ...createUserDto,
      password: hashedPassword, 
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // this.userRepository.save():
    // 真正的数据库写操作。相当于 SQL 的 INSERT 或 Mongo 的 db.collection.save()
    // 它会返回保存到数据库后的完整对象（包括自动生成的 _id）
    return await this.userRepository.save(newUser);
  }

  async findAll() {
    // find(): 查找所有记录。
    // 相当于 SELECT * FROM users
    return await this.userRepository.find();
  }

  async findOne(id: string) {
    // ObjectId 校验：MongoDB 的 ID 是特定格式的，如果格式不对（比如长度不够），直接查询会报错
    if (!ObjectId.isValid(id)) {
      throw new NotFoundException(`Invalid ID format`);
    }

    // findOneBy(): 根据条件查询单条记录。
    // 注意：MongoDB 中主键是 _id，且类型是 ObjectId 对象，不能直接传字符串
    const user = await this.userRepository.findOneBy({ _id: new ObjectId(id) });
    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }
    return user;
  }

  async update(id: string, updateUserDto: UpdateUserDto) {
    if (!ObjectId.isValid(id)) {
      throw new NotFoundException(`Invalid ID format`);
    }

    // 1. 先查询是否存在，确保我们在更新一个有效用户
    const user = await this.findOne(id);
    
    // 2. 准备更新的数据
    let updateData: any = { ...updateUserDto, updatedAt: new Date() };
    if (updateUserDto.password) {
        updateData.password = await this.hashingService.hash(updateUserDto.password);
    }

    // 3. 执行更新
    // update(条件, 数据): 相当于 UPDATE users SET ... WHERE ...
    // 注意：TypeORM 的 update 方法不会返回更新后的数据对象，只返回操作结果（如 affected: 1）
    await this.userRepository.update(id, updateData);
    
    // 4. 因为 update 不返回新数据，我们手动合并返回，或者再次调用 findOne(id)
    return { ...user, ...updateData };
  }

  async remove(id: string) {
    if (!ObjectId.isValid(id)) {
      throw new NotFoundException(`Invalid ID format`);
    }
    // delete(): 根据 ID 删除记录
    // 相当于 DELETE FROM users WHERE id = ...
    const result = await this.userRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }
    return { deleted: true };
  }
}
