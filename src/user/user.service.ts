import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ObjectId } from 'mongodb';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { HashingService } from '../common/hashing/hashing.service';
import { User } from './entities/user.mongo.entity';

import { PaginationQueryDto } from '../common/dto/pagination.dto';

@Injectable()
export class UserService {
  // 1. 初始化 Logger，上下文设置为 'UserService'，这样日志里会显示 [UserService]
  private readonly logger = new Logger(UserService.name);

  // 构造函数注入：依赖注入的核心
  constructor(
    // @InjectRepository(User): 是一个装饰器，告诉 NestJS "请给我 User 实体的仓库"
    // Repository<User>: TypeORM 提供的泛型类，里面内置了 find, save, delete 等几十种操作数据库的方法
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly hashingService: HashingService,
  ) {}

  async create(createUserDto: CreateUserDto) {
    // 2. 记录业务日志
    this.logger.log(`开始创建用户: ${createUserDto.email}`);
    
    // 使用共享模块 HashingService 对密码进行加密
    const hashedPassword = await this.hashingService.hash(createUserDto.password);
    
    // this.userRepository.create(): 
    // 这是一个纯内存操作。它接收普通对象(DTO)，返回一个 User 实体对象。
    // 此时数据还没有存入数据库！它的作用是确保对象符合 Entity 的定义。
    const newUser = this.userRepository.create({
      ...createUserDto,
      password: hashedPassword, 
    });

    // this.userRepository.save():
    // 真正的数据库写操作。相当于 SQL 的 INSERT 或 Mongo 的 db.collection.save()
    // 它会返回保存到数据库后的完整对象（包括自动生成的 _id）
    const savedUser = await this.userRepository.save(newUser);
    
    this.logger.log(`用户创建成功, ID: ${savedUser._id}`);
    
    return savedUser;
  }

  async findAll(query: PaginationQueryDto) {
    const { page = 1, limit = 10 } = query;
    const skip = (page - 1) * limit;

    // findAndCount: 同时返回 数据数组 和 总条数
    const [data, total] = await this.userRepository.findAndCount({
      skip,
      take: limit,
      order: { createdAt: 'DESC' }, // 按创建时间倒序
    });

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
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

  async findByPhoneNumber(phoneNumber: string): Promise<User | null> {
    return this.userRepository.findOneBy({ phoneNumber });
  }

  async update(id: string, updateUserDto: UpdateUserDto) {
    if (!ObjectId.isValid(id)) {
      throw new NotFoundException(`Invalid ID format`);
    }

    // 1. 先查询是否存在，确保我们在更新一个有效用户
    const user = await this.findOne(id);
    
    // 2. 准备更新的数据
    let updateData: any = { ...updateUserDto };
    if (updateUserDto.password) {
        updateData.password = await this.hashingService.hash(updateUserDto.password);
    }

    // 3. 执行更新
    // update(条件, 数据): 相当于 UPDATE users SET ... WHERE ...
    // 注意：TypeORM 的 update 方法不会返回更新后的数据对象，只返回操作结果（如 affected: 1）
    await this.userRepository.update(id, updateData);
    
    // 4. 因为 update 不返回新数据，我们手动合并返回，或者再次调用 findOne(id)
    // 注意：updatedAt 会由 TypeORM 自动更新，但为了返回最新数据，这里手动合并可能不准确（时间差）
    // 最好是再次查询，或者直接返回合并后的对象（接受 updatedAt 可能稍微旧一点）
    // 为了严谨，这里再次查询一次，或者简单返回
    return { ...user, ...updateData };
  }

  async remove(id: string) {
    if (!ObjectId.isValid(id)) {
      throw new NotFoundException(`Invalid ID format`);
    }
    // softDelete(): 软删除
    // 相当于 UPDATE users SET deletedAt = NOW() WHERE id = ...
    // 查询时 TypeORM 会自动过滤掉 deletedAt 不为空的记录
    const result = await this.userRepository.softDelete(id);
    if (result.affected === 0) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }
    return { deleted: true };
  }
}
