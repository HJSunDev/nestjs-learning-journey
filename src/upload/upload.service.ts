import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ensureDir, outputFile } from 'fs-extra';
import { join, resolve } from 'path';
import { HashingService } from '../common/hashing/hashing.service';

@Injectable()
export class UploadService {
  constructor(
    private readonly configService: ConfigService,
    private readonly hashingService: HashingService,
  ) {}

  /**
   * 上传文件
   * @param file - Multer 文件对象
   * @returns 文件访问 URL 和 存储路径
   */
  async upload(file: Express.Multer.File) {
    // 1. 获取上传目录配置
    // 如果配置为空，使用默认目录 'static/upload'
    const configUploadDir =
      this.configService.get<string>('upload.dir') || 'static/upload';

    // 使用 resolve 自动处理:
    // - 如果 configUploadDir 是绝对路径，则直接使用
    // - 如果是相对路径，则将其解析为相对于 process.cwd() 的绝对路径
    const uploadDir = resolve(process.cwd(), configUploadDir);

    // 2. 确保目录存在 (fs-extra 的 ensureDir 会自动创建多级目录)
    await ensureDir(uploadDir);

    // 3. 生成文件名: 使用文件内容的 MD5 哈希作为文件名，实现内容寻址 (可去重)
    const fileHash = this.hashingService.calculateFileHash(file.buffer);
    const fileExtension = file.originalname.split('.').pop(); // 获取后缀名
    const fileName = `${fileHash}.${fileExtension}`;

    // 4. 拼接完整的文件存储路径
    const uploadPath = join(uploadDir, fileName);

    // 5. 写入文件
    await outputFile(uploadPath, file.buffer);

    // 6. 返回结果
    // 这里的 URL 前缀 '/static/upload' 必须与 main.ts 中 serveStatic 的 prefix 保持一致
    return {
      url: `/static/upload/${fileName}`,
      path: uploadPath,
      filename: fileName,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
    };
  }
}
