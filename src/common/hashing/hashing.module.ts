import { Module } from '@nestjs/common';
import { HashingService } from './hashing.service';

@Module({
  providers: [HashingService],
  exports: [HashingService], // 关键：导出服务，使其对导入此模块的其他模块可见
})
export class HashingModule {}

