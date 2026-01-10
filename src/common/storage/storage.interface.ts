/**
 * 文件存储服务抽象层
 *
 * 遵循 DIP (依赖倒置原则)：业务代码依赖接口而非具体实现
 * 遵循 OCP (开闭原则)：新增存储驱动只需实现接口，无需修改现有代码
 */

/**
 * 存储操作返回结果
 */
export interface StorageResult {
  /**
   * 文件访问 URL (对外暴露的完整路径)
   * 本地存储: /static/upload/xxx.jpg
   * OSS 存储: https://bucket.oss-cn-hangzhou.aliyuncs.com/xxx.jpg
   */
  url: string;

  /**
   * 存储标识符 (用于删除、查询等操作)
   * 本地存储: 文件名 (如 abc123.jpg)
   * OSS 存储: Object Key (如 uploads/abc123.jpg)
   */
  key: string;

  /**
   * 文件名
   */
  filename: string;
}

/**
 * 存储服务接口
 *
 * 所有存储驱动 (Local, OSS) 都必须实现此接口
 */
export interface IStorageService {
  /**
   * 上传文件
   * @param buffer - 文件二进制数据
   * @param filename - 文件名 (含扩展名)
   * @returns 存储结果
   */
  upload(buffer: Buffer, filename: string): Promise<StorageResult>;

  /**
   * 删除文件
   * @param key - 存储标识符
   */
  delete(key: string): Promise<void>;

  /**
   * 获取文件访问 URL
   * @param key - 存储标识符
   * @returns 完整的访问 URL
   */
  getUrl(key: string): string;

  /**
   * 检查文件是否存在
   * @param key - 存储标识符
   * @returns 是否存在
   */
  exists(key: string): Promise<boolean>;
}

/**
 * 存储服务注入 Token
 *
 * NestJS 依赖注入系统使用 Token 来标识 Provider
 * 当依赖接口而非具体类时，需要使用字符串 Token 进行注入
 */
export const STORAGE_SERVICE = 'STORAGE_SERVICE';

/**
 * 存储驱动类型枚举
 */
export enum StorageDriver {
  LOCAL = 'local',
  OSS = 'oss',
}
