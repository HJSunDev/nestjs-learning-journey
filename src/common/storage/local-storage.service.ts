import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ensureDir, outputFile, remove, pathExists } from 'fs-extra';
import { join, resolve } from 'path';
import { IStorageService, StorageResult } from './storage.interface';

/**
 * 本地文件系统存储实现
 *
 * 适用场景：
 * - 开发环境
 * - 单机部署
 * - 低流量场景
 *
 * 注意：多实例/集群部署时需迁移至 OSS 等共享存储
 */
@Injectable()
export class LocalStorageService implements IStorageService {

  private readonly logger = new Logger(LocalStorageService.name);

  /**
   * 本地存储目录的绝对路径
   */
  private readonly storageDir: string;

  /**
   * URL 前缀 (用于拼接访问路径)
   */
  private readonly urlPrefix: string;

  constructor(private readonly configService: ConfigService) {
    // 从配置读取存储目录，默认为 'static/upload'
    const configDir = this.configService.get<string>('storage.local.dir') || 'static/upload';

    // 解析为绝对路径（支持相对路径和绝对路径的自动归一化）
    this.storageDir = resolve(process.cwd(), configDir);

    // URL 前缀配置
    this.urlPrefix = this.configService.get<string>('storage.local.prefix') || '/static/upload';

    this.logger.log(`本地存储初始化完成: ${this.storageDir}`);
  }

  /**
   * 上传文件到本地磁盘
   */
  async upload(buffer: Buffer, filename: string): Promise<StorageResult> {
    // 确保目录存在
    await ensureDir(this.storageDir);

    // 拼接完整路径
    const filePath = join(this.storageDir, filename);

    // 写入文件
    await outputFile(filePath, buffer);

    this.logger.debug(`文件已上传: ${filePath}`);

    return {
      url: this.getUrl(filename),
      key: filename,
      filename,
    };
  }

  /**
   * 删除文件
   */
  async delete(key: string): Promise<void> {
    const filePath = join(this.storageDir, key);

    if (await pathExists(filePath)) {
      await remove(filePath);
      this.logger.debug(`文件已删除: ${filePath}`);
    }
  }

  /**
   * 获取文件访问 URL
   */
  getUrl(key: string): string {
    // 确保 URL 格式正确：prefix + / + key
    const prefix = this.urlPrefix.endsWith('/')
      ? this.urlPrefix.slice(0, -1)
      : this.urlPrefix;

    return `${prefix}/${key}`;
  }

  /**
   * 检查文件是否存在
   */
  async exists(key: string): Promise<boolean> {
    const filePath = join(this.storageDir, key);
    return pathExists(filePath);
  }
}
