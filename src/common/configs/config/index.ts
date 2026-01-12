/**
 * 配置文件统一导出
 * 
 * 使用 registerAs 创建的命名空间配置，
 * 通过 ConfigModule.forRoot({ load: [...] }) 加载
 */
import appConfig from './app.config';
import databaseConfig from './database.config';
import redisConfig from './redis.config';
import jwtConfig from './jwt.config';
import storageConfig from './storage.config';
import corsConfig from './cors.config';
import loggerConfig from './logger.config';

export {
  appConfig,
  databaseConfig,
  redisConfig,
  jwtConfig,
  storageConfig,
  corsConfig,
  loggerConfig,
};

// 所有配置的聚合数组，用于 ConfigModule.forRoot({ load: [...] })
export const configurations = [
  appConfig,
  databaseConfig,
  redisConfig,
  jwtConfig,
  storageConfig,
  corsConfig,
  loggerConfig,
];
