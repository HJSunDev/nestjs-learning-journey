import { Module, Global, Logger } from '@nestjs/common';

import { ConfigService } from '@nestjs/config';

import { STORAGE_SERVICE, StorageDriver } from './storage.interface';
import { LocalStorageService } from './local-storage.service';

/**
 * 存储服务模块
 *
 * 使用工厂模式根据配置动态选择存储驱动
 * @Global 装饰器使该模块在全局可用，无需在每个模块中导入
 */
@Global()
@Module({
  providers: [
    {
      provide: STORAGE_SERVICE,
      useFactory: (configService: ConfigService) => {
        
        const logger = new Logger('StorageModule');
        const driver = configService.get<string>('storage.driver') || StorageDriver.LOCAL;

        logger.log(`初始化存储驱动: ${driver}`);

        switch (driver) {
          case StorageDriver.OSS:
            // OSS 驱动预留，后续实现 OssStorageService
            logger.warn(
              'OSS 驱动尚未实现, 回退到本地存储',
            );
            return new LocalStorageService(configService);

          case StorageDriver.LOCAL:
          default:
            return new LocalStorageService(configService);
        }
      },
      inject: [ConfigService],
    },
  ],
  exports: [STORAGE_SERVICE],
})
export class StorageModule {}
