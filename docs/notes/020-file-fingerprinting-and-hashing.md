# 020. 文件指纹技术与哈希命名 (File Fingerprinting & Hashing)

## 1. 核心说明 (Core Concept)

### 1.1 文件命名方案演进
在文件上传系统的设计中，文件名的生成策略直接决定了系统的健壮性和存储效率。以下是四种常见的命名方案对比：

| 方案 | 命名规则 | 缺点 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **方案 1: 文件原名** | 使用用户上传时的原始文件名 (e.g. `resume.pdf`) | **覆盖风险**: 用户 A 和 B 上传同名文件，后者覆盖前者。 | 仅限单人使用的本地脚本 |
| **方案 2: 时间戳** | `Date.now()` + 扩展名 | **并发冲突**: 高并发下毫秒级碰撞，依然可能覆盖。 | 低并发、非关键日志文件 |
| **方案 3: 随机串/UUID** | `uuid()` + 扩展名 | **资源浪费**: 1000 人上传同一张默认头像，服务器存 1000 份。 | 这里的确需要唯一的临时文件 |
| **方案 4: 文件指纹 (推荐)** | **文件内容的哈希值** (MD5/SHA) | **无** (除极其罕见的哈希碰撞外)。 | **生产级文件存储、秒传、去重** |

**核心优势**:
- **幂等性**: 同一个文件无论上传多少次，文件名永远一致。
- **存储优化**: 天然实现文件去重（Deduplication）。如果文件名已存在，无需再次写入磁盘。

---

### 1.2 技术选型：为什么是 Crypto?

我们使用 Node.js 原生模块 `crypto` 来实现文件指纹计算。

**它是什么?**
- Node.js 的核心模块（Built-in Module），无需 `npm install`。
- 基于 OpenSSL 库构建，提供加密、哈希、签名等底层密码学功能。

**为什么不用 Bcrypt?**
虽然我们之前在用户密码加密中使用了 `bcrypt`，但在文件指纹场景下，必须切换到 `crypto (MD5/SHA)`。

| 维度 | Crypto (MD5) | Bcrypt | 结论 |
| :--- | :--- | :--- | :--- |
| **设计目标** | **完整性校验** (Integrity) | **密码保护** (Password Hashing) | - |
| **计算速度** | **极快** (适合大文件流式计算) | **极慢** (故意设计慢以防暴力破解) | 文件处理选 MD5 |
| **确定性** | **确定** (输入不变，输出不变) | **随机** (内置随机盐，每次结果不同) | 文件去重选 MD5 |
| **输出结果** | 32位 16进制字符串 (指纹) | 60位包含盐和配置的字符串 | - |

**总结**: 
- **Bcrypt** 是为了让黑客猜不出密码。
- **Crypto(MD5)** 是为了给文件办一张唯一的“身份证”。

---

## 2. 行动指南 (Action Guide)

以下步骤演示如何将文件指纹计算集成到现有架构中。

### Step 1: 扩展 HashingService
**目标**: 在通用的哈希服务中，新增一个基于 `crypto` 的文件指纹计算方法。

```typescript
// src/common/hashing/hashing.service.ts
import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto'; // 1. 引入原生 crypto 模块

@Injectable()
export class HashingService {
  // ... (保留原有的 bcrypt 方法) ...

  /**
   * 计算文件的 MD5 指纹
   * 用于文件去重、秒传校验
   */
  calculateFileHash(buffer: Buffer): string {
    // 2. 创建 MD5 哈希实例
    const md5 = crypto.createHash('md5');
    // 3. 更新数据并输出 hex 格式
    return md5.update(buffer).digest('hex');
  }
}
```

### Step 2: 注册模块依赖
**目标**: 确保 `UploadModule` 可以使用 `HashingService`。

```typescript
// src/upload/upload.module.ts
import { Module } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { HashingModule } from '../common/hashing/hashing.module'; // 导入共享模块

@Module({
  imports: [HashingModule], // 注册依赖
  controllers: [UploadController],
})
export class UploadModule {}
```

### Step 3: 在 Controller 中应用
**目标**: 接收上传文件，计算其指纹，并作为响应返回（或作为保存文件名）。

```typescript
// src/upload/upload.controller.ts
import { HashingService } from '../common/hashing/hashing.service';

@Controller('upload')
export class UploadController {
  // 注入服务
  constructor(private readonly hashingService: HashingService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(@UploadedFile() file: Express.Multer.File) {
    
    // 调用服务计算 MD5
    const fileHash = this.hashingService.calculateFileHash(file.buffer);

    // 实际场景：使用 hash + 扩展名 重命名文件
    // const filename = `${fileHash}.${file.originalname.split('.').pop()}`;

    return {
      originalName: file.originalname,
      md5_fingerprint: fileHash, // 返回指纹供前端校验
      size: file.size
    };
  }
}
```
