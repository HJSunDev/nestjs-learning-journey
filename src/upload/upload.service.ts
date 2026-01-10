import { Inject, Injectable } from '@nestjs/common';

import { HashingService } from '../common/hashing/hashing.service';
import { STORAGE_SERVICE } from '../common/storage';
import type { IStorageService } from '../common/storage';

@Injectable()
export class UploadService {
  constructor(
    @Inject(STORAGE_SERVICE)
    private readonly storageService: IStorageService,
    private readonly hashingService: HashingService,
  ) {}

  /**
   * 上传文件
   * @param file - Multer 文件对象
   * @returns 文件访问信息
   */
  async upload(file: Express.Multer.File) {
    // 1. 生成文件名: 使用文件内容的 MD5 哈希作为文件名，实现内容寻址 (可去重)
    const fileHash = this.hashingService.calculateFileHash(file.buffer);
    const fileExtension = file.originalname.split('.').pop(); // 获取后缀名
    const fileName = `${fileHash}.${fileExtension}`;

    // 2. 调用抽象存储服务（不关心具体实现是本地还是 OSS）
    const result = await this.storageService.upload(file.buffer, fileName);

    // 3. 返回结果
    return {
      ...result,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
    };
  }

  /**
   * 删除文件
   * @param key - 存储标识符
   */
  async delete(key: string): Promise<void> {
    await this.storageService.delete(key);
  }

  /**
   * 检查文件是否存在
   * @param key - 存储标识符
   */
  async exists(key: string): Promise<boolean> {
    return this.storageService.exists(key);
  }
}
