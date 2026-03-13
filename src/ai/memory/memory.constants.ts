/**
 * 会话历史 Redis Key 的统一前缀
 *
 * 与项目中其他 Redis Key（如 refresh_token:）保持命名风格一致，
 * 通过前缀隔离不同业务域的数据。
 */
export const MEMORY_KEY_PREFIX = 'chat_history:';

/** 会话默认 TTL（秒），1 小时无操作自动过期 */
export const DEFAULT_SESSION_TTL = 3600;

/** 默认历史窗口大小（消息条数），控制发送给模型的上下文长度 */
export const DEFAULT_WINDOW_SIZE = 20;
