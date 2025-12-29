# 014. 三层架构与生产级目录规范

## 1. 架构分层定义 (Layer Definitions)

NestJS 采用经典的三层架构，通过 **依赖注入 (DI)** 实现各层解耦。

### 1.1 Controller 层 (表现层)

- **职责**: 接收 HTTP 请求，解析参数，调用业务逻辑，返回响应。
- **规范**:
  - 禁止包含复杂业务逻辑。
  - 禁止直接操作数据库。
  - 输入输出必须使用 DTO 进行定义和校验。

### 1.2 Service 层 (业务逻辑层)

- **职责**: 实现核心业务规则，处理事务，编排数据。
- **规范**:
  - 纯 TypeScript 类，不应依赖 HTTP 上下文 (Request/Response)。
  - 作为 Provider 被 Module 导出和注入。

### 1.3 Repository 层 (数据访问层)

- **职责**: 直接与数据库交互 (CRUD)。
- **规范**:
  - 通过 TypeORM Repository 或 Mongoose Model 实现。
  - 负责 Entity 与数据库记录的映射。

---

## 2. 生产级目录规范 (Production Directory Standards)

NestJS 推荐的领域驱动目录结构

目录策略：**默认扁平，拒绝深层嵌套**。

### 2.1 标准模块结构 (Standard Module Layout)

无论模块大小，**严格遵守**以下结构：

```text
src/user/
├── dto/                    # [必选] 数据传输对象
│   ├── create-user.dto.ts
│   └── update-user.dto.ts
├── entities/               # [必选] 数据库实体/Schema
│   └── user.entity.ts
├── user.controller.ts      # [核心] 扁平放置，禁止创建 controllers 文件夹
├── user.service.ts         # [核心] 扁平放置，禁止创建 services 文件夹
├── user.module.ts          # [核心] 模块入口
└── user.constants.ts       # [可选] 常量定义
```

### 2.2 特殊文件归属 (File Placement Guide)

| 文件类型               | 推荐位置                 | 说明                                            |
| :--------------------- | :----------------------- | :---------------------------------------------- |
| **Strategy**     | `src/auth/strategies/` | 认证策略统一归 `Auth` 模块管理。              |
| **Guard (通用)** | `src/common/guards/`   | 全局通用的守卫 (如 `RolesGuard`)。            |
| **Guard (专用)** | `src/user/guards/`     | 仅在该模块内部使用的特定守卫。                  |
| **Provider**     | `src/user/providers/`  | 自定义 Provider (非标准 Service) 可放入文件夹。 |

---

## 3. 复杂场景解决方案 (The Definitive Solution)

当模块变大或逻辑变复杂时，依据 **“执行者 (Actor)”** 标准进行拆分。

### 3.1 场景一：面向不同人群 (Cross-Context)

**情况**: User 模块既要提供“用户修改资料”接口 (C端)，又要提供“管理员封号”接口 (Admin端)。
**判定**: 执行者不同 (User vs Admin)，权限上下文完全不同。
**❌ 错误做法**: 在 `src/user/` 下创建 `admin-user.controller.ts`。
**✅ 唯一标准解法**: **拆分模块 (Split Modules)**。

建立独立的 `AdminModule` 来专门处理所有管理端逻辑。

```text
src/
├── user/                   # [C端] 用户模块
│   └── user.controller.ts  # 仅包含用户自己的操作
└── admin/                  # [Admin端] 管理模块
    ├── admin.module.ts
    ├── admin-user.controller.ts # 管理员管理用户
    └── admin-order.controller.ts # 管理员管理订单
```

> **理由**: Admin 模块通常需要统一的 `AdminGuard`，独立的模块可以一次性配置全局守卫，彻底隔离权限风险。

### 3.2 场景二：面向同一人群，但功能过多 (Large Feature)

**情况**: `UserController` 面向 C 端用户，但包含了资料、安全、积分、签到等 50 个接口，文件超过 1000 行。
**判定**: 执行者相同，但业务聚合度过高。
**❌ 错误做法**: 创建 `src/user/controllers/` 文件夹嵌套。
**✅ 唯一标准解法**: **同级平铺 (Flat Splitting)**。

直接在模块根目录下按功能拆分文件，保持扁平。

```text
src/user/
├── user-profile.controller.ts  # 资料相关
├── user-security.controller.ts # 密码、绑定相关
├── user.service.ts             # Service 也可以对应拆分
└── user.module.ts
```

> **理由**: 保持了目录层级的一致性（一眼就能看到所有 Controller），同时解决了单文件过大的问题。

---

## 4. 快速上手代码模板 (Quick Start Templates)

### Step 1: 定义数据契约 (DTO)

```typescript
// src/user/dto/create-user.dto.ts
import { IsEmail, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateUserDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  password: string;
}
```

### Step 2: 实现业务逻辑 (Service)

```typescript
// src/user/user.service.ts
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async create(dto: CreateUserDto) {
    const user = this.userRepository.create(dto);
    return this.userRepository.save(user);
  }
}
```

### Step 3: 暴露接口 (Controller)

```typescript
// src/user/user.controller.ts
import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';

@ApiTags('用户管理')
@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post()
  @ApiOperation({ summary: '创建新用户' })
  create(@Body() dto: CreateUserDto) {
    return this.userService.create(dto);
  }
}
```
