/**
 * Token 存储相关常量
 * 集中管理 Redis Key 前缀和其他配置常量
 */

/**
 * Redis Key 前缀
 * 命名规范：{业务域}:{资源类型}:{标识符}
 */
export const REDIS_KEY_PREFIX = {
  /**
   * Refresh Token 存储 Key 前缀
   * 完整格式：auth:refresh:{userId}
   */
  REFRESH_TOKEN: 'auth:refresh',
} as const;

/**
 * 时间单位换算（秒）
 */
export const TIME_IN_SECONDS = {
  MINUTE: 60,
  HOUR: 3600,
  DAY: 86400,
  WEEK: 604800,
} as const;

/**
 * 将 JWT 过期时间字符串解析为秒数
 * 支持格式：15m, 1h, 7d, 30d 等
 * @param expiresIn JWT 过期时间字符串
 * @returns 秒数
 */
export function parseExpiresInToSeconds(expiresIn: string): number {
  const match = expiresIn.match(/^(\d+)([smhd])$/);
  if (!match) {
    // 默认 7 天
    return TIME_IN_SECONDS.WEEK;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's':
      return value;
    case 'm':
      return value * TIME_IN_SECONDS.MINUTE;
    case 'h':
      return value * TIME_IN_SECONDS.HOUR;
    case 'd':
      return value * TIME_IN_SECONDS.DAY;
    default:
      return TIME_IN_SECONDS.WEEK;
  }
}
