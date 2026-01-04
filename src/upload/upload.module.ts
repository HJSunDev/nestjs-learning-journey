import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { HashingModule } from '../common/hashing/hashing.module';

@Module({
  imports: [HashingModule],
  controllers: [UploadController],
})
export class UploadModule {}

