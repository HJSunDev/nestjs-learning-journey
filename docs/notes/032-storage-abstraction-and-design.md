# 032. 文件存储架构与抽象层设计 (Storage Abstraction)

---

## Part 1: 设计说明

---

### 1.1 为什么需要存储抽象层

#### 问题背景

传统的文件上传实现直接使用 `fs-extra` 将文件写入本地磁盘，这种方式存在两个核心问题：

1. **水平扩展失效**: 在 Docker 集群或多实例部署中，各容器/实例拥有独立的文件系统。用户 A 的文件上传到实例 1，当下次请求被负载均衡分配到实例 2 时，文件不存在。
2. **强耦合**: 业务代码直接调用 `fs-extra` 的 `outputFile`、`remove` 等方法。当需要迁移到阿里云 OSS 时，必须修改所有涉及文件操作的业务代码。

#### 解决方案

引入 **存储抽象层**，业务代码依赖接口 (Interface) 而非具体实现 (Class)。通过配置切换存储后端，无需修改业务代码。

### 1.2 架构设计

我们采用 **接口-实现-工厂** 三层架构：

```
┌─────────────────────────────────────────────────────────────────┐
│                        UploadService                            │
│                     (业务层：调用接口)                            │
└─────────────────────────────┬───────────────────────────────────┘
                              │ @Inject(STORAGE_SERVICE)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      IStorageService                            │
│                (抽象接口：upload / delete / exists)              │
└─────────────────────────────┬───────────────────────────────────┘
                              │ StorageModule (Factory Provider)
              ┌───────────────┴───────────────┐
              ▼                               ▼
      ┌──────────────┐                ┌──────────────┐
      │LocalStorage  │                │ OssStorage   │
      │  (已实现)     │                │  (预留)      │
      └──────────────┘                └──────────────┘
```

**核心组件**:

| 组件 | 职责 |
|------|------|
| `IStorageService` | 定义存储操作的标准契约 (upload, delete, getUrl, exists) |
| `STORAGE_SERVICE` | 依赖注入 Token，用于运行时绑定具体实现 |
| `LocalStorageService` | 本地文件系统存储的具体实现 |
| `StorageModule` | 工厂模块，根据 `STORAGE_DRIVER` 配置动态选择实现 |

### 1.3 设计特点

1. **依赖倒置 (DIP)**: `UploadService` 依赖 `IStorageService` 接口，而非 `LocalStorageService` 类。
2. **开闭原则 (OCP)**: 新增 OSS 驱动只需实现接口并修改工厂，无需修改业务代码。
3. **配置驱动**: 通过环境变量 `STORAGE_DRIVER` 切换存储后端，支持 `local` 和 `oss`。
4. **全局可用**: `StorageModule` 使用 `@Global()` 装饰器，无需在每个模块中导入。

### 1.4 接口命名规范

`IStorageService` 中的 `I` 前缀代表 **Interface (接口)**，这是 TypeScript/C# 社区的命名惯例：

- `IUser` = 用户接口
- `ILogger` = 日志接口
- `IStorageService` = 存储服务接口

它与 "local" 无关，任何实现此接口的类 (LocalStorageService, OssStorageService) 都可以被注入。

---

## Part 2: 行动指南 (Action Guide)

---

以下是完整的实现代码，可直接复制到项目中使用。

### Step 1: 创建目录结构

```bash
mkdir -p src/common/storage
```

目标结构：
```
src/common/storage/
  ├── storage.interface.ts      # 接口定义 + Token + 枚举
  ├── local-storage.service.ts  # 本地存储实现
  ├── storage.module.ts         # 工厂模块
  └── index.ts                  # 统一导出
```

### Step 2: 定义接口与常量

**文件**: `src/common/storage/storage.interface.ts`

```typescript
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
```

### Step 3: 实现本地存储驱动

**文件**: `src/common/storage/local-storage.service.ts`

```typescript
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
```

### Step 4: 创建工厂模块

**文件**: `src/common/storage/storage.module.ts`

```typescript
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
            logger.warn('OSS 驱动尚未实现, 回退到本地存储');
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
```

### Step 5: 创建统一导出

**文件**: `src/common/storage/index.ts`

```typescript
/**
 * Storage 模块统一导出
 */
export * from './storage.interface';
export * from './storage.module';
export * from './local-storage.service';
```

### Step 6: 配置环境变量

**文件**: `.env`

```env
# === 文件存储配置 ===
# 存储驱动: local | oss
STORAGE_DRIVER=local

# 本地存储配置
STORAGE_LOCAL_DIR=static/upload
STORAGE_LOCAL_PREFIX=/static/upload

# === 阿里云 OSS 配置 (预留) ===
# STORAGE_OSS_REGION=oss-cn-hangzhou
# STORAGE_OSS_BUCKET=your-bucket-name
# STORAGE_OSS_ACCESS_KEY_ID=your-access-key-id
# STORAGE_OSS_ACCESS_KEY_SECRET=your-access-key-secret
```

### Step 7: 更新 ConfigModule 配置

在 `app-config.module.ts` 的 `validationSchema` 中添加：

```typescript
// 文件存储配置
STORAGE_DRIVER: Joi.string().valid('local', 'oss').default('local'),
STORAGE_LOCAL_DIR: Joi.string().allow('').optional(),
STORAGE_LOCAL_PREFIX: Joi.string().default('/static/upload'),
```

在 `load` 函数中添加结构化配置：

```typescript
storage: {
  driver: process.env.STORAGE_DRIVER || 'local',
  local: {
    dir: process.env.STORAGE_LOCAL_DIR || 'static/upload',
    prefix: process.env.STORAGE_LOCAL_PREFIX || '/static/upload',
  },
  oss: {
    region: process.env.STORAGE_OSS_REGION,
    bucket: process.env.STORAGE_OSS_BUCKET,
    accessKeyId: process.env.STORAGE_OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.STORAGE_OSS_ACCESS_KEY_SECRET,
  },
},
```

### Step 8: 更新 main.ts 静态资源配置

```typescript
// 配置静态资源服务 (仅本地存储模式需要)
// 当使用 OSS 等云存储时，文件通过 CDN 直接访问，无需此配置
const storageDriver = configService.get<string>('storage.driver') || 'local';

if (storageDriver === 'local') {
  const localDir = configService.get<string>('storage.local.dir') || 'static/upload';
  const localPrefix = configService.get<string>('storage.local.prefix') || '/static/upload';
  const uploadDir = resolve(process.cwd(), localDir);

  app.useStaticAssets(uploadDir, {
    prefix: localPrefix,
  });
}
```

### Step 9: 业务层调用

**文件**: `src/upload/upload.service.ts`

```typescript
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
   */
  async upload(file: Express.Multer.File) {
    // 生成文件名: 使用文件内容的 MD5 哈希
    const fileHash = this.hashingService.calculateFileHash(file.buffer);
    const fileExtension = file.originalname.split('.').pop();
    const fileName = `${fileHash}.${fileExtension}`;

    // 调用抽象存储服务
    const result = await this.storageService.upload(file.buffer, fileName);

    return {
      ...result,
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
    };
  }

  async delete(key: string): Promise<void> {
    await this.storageService.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.storageService.exists(key);
  }
}
```

**注意**: `IStorageService` 必须使用 `import type` 导入，因为 TypeScript 在 `isolatedModules` 模式下需要区分类型导入和值导入。

### Step 10: 模块导入

**文件**: `src/upload/upload.module.ts`

```typescript
import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { HashingModule } from '../common/hashing/hashing.module';
import { StorageModule } from '../common/storage';

@Module({
  imports: [
    HashingModule,
    StorageModule, // 存储抽象层
  ],
  controllers: [UploadController],
  providers: [UploadService],
  exports: [UploadService],
})
export class UploadModule {}
```

---

## 扩展：新增 OSS 驱动

当需要接入阿里云 OSS 时：

1. 创建 `src/common/storage/oss-storage.service.ts`，实现 `IStorageService` 接口。
2. 在 `storage.module.ts` 的 `switch` 中添加 OSS 分支。
3. 配置 `.env` 中的 OSS 相关环境变量。
4. **无需修改任何业务代码**。
