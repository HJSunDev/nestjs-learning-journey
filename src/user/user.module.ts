import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { HashingModule } from '../common/hashing/hashing.module';
import { User } from './entities/user.entity';

@Module({
  imports: [
    // 告诉 NestJS："UserModule 需要操作 User 实体对应的表"。
    // 只有写了这一行，UserService 里的 @InjectRepository(User) 才能正常工作。
    TypeOrmModule.forFeature([User]), 
    HashingModule,
  ],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
