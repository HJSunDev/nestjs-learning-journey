# 021. 文件上传与图床搭建实战 (Upload & Image Hosting)

## 1. 技术原理与核心组件 (Technical Principles & Core Components)

### 1.1 文件系统增强库 (fs-extra)

**什么是 fs-extra**:
`fs-extra` 是 Node.js 原生 `fs` 模块的扩展替代品。它继承了原生 `fs` 的所有方法，并添加了许多实用的文件系统操作方法。

**核心差异与优势**:

- **Drop-in Replacement**: 它完全兼容原生 `fs`，你可以用 `import * as fs from 'fs-extra'` 直接替换原生引入。
- **原子性操作**: 原生 `fs` 在写入文件前通常需要手动检查目录是否存在。`fs-extra` 提供了如 `ensureDir` (确保目录存在，不存在则创建) 和 `outputFile` (自动创建目录并写入文件) 等高级方法，大大简化了防御性编程的代码量。
- **Promise 支持**: 所有方法默认支持 Promise，完美适配 async/await 语法。

**最佳实践**:
在 NestJS 服务层处理文件 I/O 时，优先使用 `fs-extra` 来处理目录创建、移动、复制等操作，以减少对 `try-catch` 和 `if-exists` 检查的冗余依赖。

### 1.2 路径处理机制: join vs resolve

Node.js 的 `path` 模块提供了两种主要的路径处理方法，理解其区别对于构建跨平台、容器友好的应用至关重要。

**process.cwd()**:
- **含义**: Current Working Directory (当前工作目录)。指的是你在终端执行启动命令（如 `npm run start` 或 `node dist/src/main.js`）时所在的目录。通常情况下，这就是项目的**根目录**。
- **区别**: 不同于 `__dirname` (当前代码文件所在的目录)，`process.cwd()` 是动态的，取决于运行时的上下文。
- **作用**: 它是 `path.resolve` 的基准。

**path.join([...paths])**:
- **行为**: 简单的字符串拼接。它会将所有参数按操作系统的路径分隔符（Windows 是 `\`，Unix 是 `/`）连接起来，并规范化生成的路径（处理 `..` 和 `.`）。
- **局限**: 它不关心路径是否绝对。如果拼接结果是相对路径，它就是相对路径。
- **示例**: `join('static', 'upload')` -> `static/upload`。

**path.resolve([...paths])**:
- **行为**: 将路径或路径片段解析为**绝对路径**。它从右向左处理，直到构建出一个绝对路径。如果处理完所有参数还没得到绝对路径，它会把 **`process.cwd()`** 加到前面。
- **优势**: 无论传入的是相对路径还是绝对路径，`resolve` 都能保证返回一个确定的系统级绝对路径。
- **最佳实践**: 在处理配置文件（如 `UPLOAD_DIR`）时，**必须使用 `path.resolve`**。这能确保无论环境变量配置的是 `./static` (相对) 还是 `/var/www/static` (绝对)，程序内部始终持有一个安全的绝对路径，防止路径遍历或 Docker 容器内路径错位。

### 1.3 静态资源服务 (app.useStaticAssets)

NestJS (基于 Express 适配器时) 提供了 `useStaticAssets` 方法，用于将服务器磁盘上的物理目录映射为 HTTP 静态资源服务器。

- **功能**: 当 HTTP 请求匹配到指定前缀（如 `/static/upload`）时，服务器直接从磁盘读取对应文件并返回，不经过 Controller 逻辑。
- **应用**: 构建自建图床、托管 SPA 前端构建产物。

### 1.4 容器化部署最佳实践 (Docker Best Practices)

**1.4.1 核心策略：使用 Bind Mounts (绑定挂载)**
在文件上传场景中，**最佳实践是使用 Host Bind Mounts**（主机绑定挂载）。
虽然 Docker 也支持 Named Volumes（命名卷），但 Bind Mounts 允许你精确控制文件在宿主机上的物理存储位置，更适合需要频繁备份、迁移或外部访问的图片/文件数据。

**1.4.2 为什么这是最佳实践？**
1.  **物理分离**: 彻底实现“代码在容器里，数据在磁盘上”。
2.  **运维透明**: 运维人员可以直接进入宿主机的 `/var/lib/...` 目录查看、备份图片，而无需学习 Docker 卷管理命令。
3.  **防止意外**: 避免因删除容器或清理 Docker 系统（`docker system prune`）而误删隐式的命名卷数据。

**1.4.3 核心配置示例 (docker-compose.yml)**
以下是生产环境的标准配置模板。请注意 `volumes` 部分的映射关系。

```yaml
version: '3.8'

services:
  nest-backend:
    image: my-nest-app:latest
    container_name: nest_backend_prod
    restart: always
    
    # 环境变量：告诉 NestJS 程序，在容器内部文件应该存放在哪里
    # 注意：这个路径必须与下面的 volumes 冒号右边的路径一致
    environment:
      - UPLOAD_DIR=/app/static/upload
    
    # 核心挂载配置 (Bind Mounts)
    volumes:
      # [语法] 宿主机绝对路径 (数据源) : 容器内绝对路径 (挂载点)
      # 含义：将宿主机的 /var/lib/nest-journey/uploads 目录“插入”到容器的 /app/static/upload 位置
      - /var/lib/nest-journey/uploads:/app/static/upload
```

**1.4.4 权限注意事项**
使用 Bind Mounts 时，宿主机上的目录 (`/var/lib/nest-journey/uploads`) 必须存在，且 Docker 进程（通常为 root）必须拥有该目录的写入权限。否则容器启动时可能会因 `Permission denied` 报错。

---

## 2. 实战行动指南 (Action Guide)

### Step 1: 安装依赖

引入 `fs-extra` 及其类型定义。

```bash
npm install fs-extra
npm install -D @types/fs-extra
```

### Step 2: 配置文件系统 (Env & Config)

配置上传目录，并使用 Joi 进行校验。

**2.1 修改 `.env` (及 env.ai)**

```bash
# 文件上传配置
# 生产环境建议指定绝对路径 (如 /var/www/uploads)
# 开发环境默认为 static/upload
UPLOAD_DIR=static/upload
```

**2.2 修改 `src/common/configs/app-config.module.ts`**

```typescript
import * as Joi from 'joi';
// ...
ConfigModule.forRoot({
  validationSchema: Joi.object({
    // ... 其他配置
    UPLOAD_DIR: Joi.string().allow('').optional(), // 允许为空
  }),
  load: [() => ({
    // ...
    upload: {
      dir: process.env.UPLOAD_DIR,
    },
  })],
})
```

### Step 3: 实现上传服务 (UploadService)

实现核心逻辑：路径解析、MD5 计算、文件写入。

**`src/upload/upload.service.ts`**

```typescript
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

  async upload(file: Express.Multer.File) {
    // 1. 获取配置并使用 resolve 解析为绝对路径
    // 即使配置是相对路径 'static/upload'，也会被解析为 '/app/static/upload'
    const configUploadDir = this.configService.get<string>('upload.dir') || 'static/upload';
    const uploadDir = resolve(process.cwd(), configUploadDir);

    // 2. 确保目录存在 (fs-extra)
    await ensureDir(uploadDir);

    // 3. 计算指纹并生成文件名 (内容寻址)
    const fileHash = this.hashingService.calculateFileHash(file.buffer);
    const fileExtension = file.originalname.split('.').pop();
    const fileName = `${fileHash}.${fileExtension}`;

    // 4. 写入文件
    const uploadPath = join(uploadDir, fileName);
    await outputFile(uploadPath, file.buffer);

    // 5. 返回结果
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
```

### Step 4: 实现控制器 (UploadController)

接收 Multipart 流并调用 Service。

**`src/upload/upload.controller.ts`**

```typescript
import { Controller, Post, UseInterceptors, UploadedFile, Body } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UploadDto } from './dto/upload.dto';
import { UploadService } from './upload.service';

@ApiTags('Upload')
@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post()
  @ApiOperation({ summary: '上传单个文件' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ description: '文件上传', type: UploadDto })
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(
    @Body() uploadDto: UploadDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const result = await this.uploadService.upload(file);
    return {
      message: '文件上传成功',
      ...result,
    };
  }
}
```

### Step 5: 配置静态资源映射 (Main)

在入口文件中暴露上传目录。

**`src/main.ts`**

```typescript
import { resolve } from 'path';
// ...

async function bootstrap() {
  // ... App 创建逻辑
  const configService = app.get(ConfigService);

  // 1. 解析上传目录的绝对路径 (与 Service 逻辑保持一致)
  const configUploadDir = configService.get<string>('upload.dir') || 'static/upload';
  const uploadDir = resolve(process.cwd(), configUploadDir);

  // 2. 映射静态资源路径
  // 访问 http://localhost:3000/static/upload/xxx.jpg 将直接读取磁盘文件
  app.useStaticAssets(uploadDir, {
    prefix: '/static/upload',
  });
  
  // ...
}
```

### Step 6: 工程化配置 (Git Ignore)

**非常重要**: 防止上传的图片污染代码仓库。

**`.gitignore`**

```gitignore
# User uploads
/static/upload
```
