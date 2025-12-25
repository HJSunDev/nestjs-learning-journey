import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { HashingModule } from '../common/hashing/hashing.module';

@Module({
  imports: [HashingModule], // 导入共享模块
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}
