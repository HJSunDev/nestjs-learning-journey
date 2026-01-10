import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { HashingModule } from '../common/hashing/hashing.module';
import { StorageModule } from '../common/storage';

@Module({
  imports: [
    HashingModule,
    StorageModule, // 存储抽象层（会根据配置自动选择本地/OSS 等驱动）
  ],
  controllers: [UploadController],
  providers: [UploadService],
  exports: [UploadService],
})
export class UploadModule {}

