/**
 * Token 存储服务抽象接口
 * 遵循 DIP 原则，业务层依赖此接口而非具体实现
 * 支持 Redis/Database 等不同存储后端的切换
 */
export interface ITokenStorageService {
  /**
   * 存储 Refresh Token 哈希值
   * @param userId 用户唯一标识
   * @param hashedToken bcrypt 哈希后的 Token（非明文）
   * @param ttlSeconds 过期时间（秒），与 JWT 过期时间保持一致
   */
  set(userId: string, hashedToken: string, ttlSeconds: number): Promise<void>;

  /**
   * 获取存储的 Refresh Token 哈希值
   * @param userId 用户唯一标识
   * @returns 哈希值字符串，不存在或已过期返回 null
   */
  get(userId: string): Promise<string | null>;

  /**
   * 删除（撤销）用户的 Refresh Token
   * 用于登出场景，使 Token 立即失效
   * @param userId 用户唯一标识
   */
  delete(userId: string): Promise<void>;

  /**
   * 检查用户是否存在有效的 Refresh Token
   * 用于快速判断登录态，避免获取完整数据
   * @param userId 用户唯一标识
   */
  exists(userId: string): Promise<boolean>;
}

/**
 * 依赖注入 Token，用于在 NestJS IoC 容器中标识此接口
 */
export const TOKEN_STORAGE_SERVICE = 'TOKEN_STORAGE_SERVICE';
