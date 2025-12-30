# 015. 列表分页功能实现 (Pagination)

## 1. 深度解析：为什么需要分页？ (The "Why")

### 核心问题
当数据库数据量增大时（如几千条用户数据），一次性返回所有数据会导致：
1.  **性能雪崩**: 数据库查询变慢，网络传输大量数据耗时增加。
2.  **内存溢出 (OOM)**: 后端服务器读取大量对象到内存，或前端浏览器渲染过长列表导致卡顿崩溃。
3.  **用户体验差**: 用户无法快速定位，滚动条过长难以操作。

### 核心解决方案
我们采用 **Offset-based Pagination**（基于偏移量的分页），这是最通用、兼容性最好的方案。
- **Page**: 当前页码（第几页）。
- **Limit**: 每页显示多少条。
- **Offset**: 跳过前多少条数据 = `(page - 1) * limit`。

---

## 2. 技术原理：find vs findAndCount (The "How it works")

在实现分页时，TypeORM 提供了两个看似相似但用途完全不同的 API。

### 原 `find()` 函数
- **SQL 行为**: 相当于 `SELECT * FROM users ...`
- **返回值**: `User[]` (仅返回实体数组)
- **适用场景**:
  - 全量列表（数据量少）。
  - 下拉菜单选项。
  - 内部逻辑查询不需要展示给用户总数。
- **缺点**: 如果加上 `skip/take` 分页参数，它只会返回那一页的数据，**你无法知道总共有多少页**，前端无法渲染页码条。

### 现 `findAndCount()` 函数
- **SQL 行为**: 相当于执行了两条 SQL：
  1. `SELECT * FROM users LIMIT 10 OFFSET 0` (获取当前页数据)
  2. `SELECT COUNT(*) FROM users` (获取符合条件的总记录数，**忽略 limit/offset**)
- **返回值**: `[User[], number]` (元组：第一个元素是数据数组，第二个元素是总条数)
- **适用场景**:
  - **管理后台列表**。
  - **C端需要显示页码的内容流**。
- **优势**:
  - 能够一次性获取计算分页元数据所需的所有信息（Total -> TotalPages）。
  - TypeORM 会自动处理这两个查询的事务性（视数据库驱动而定），保证一致性。

### 参数类型转换机制 (Type Transformation)
前端传递的 Query Params 本质上都是**字符串**（例如 `?page=1`，服务器收到的是 `"1"`）。
如果直接传给 TypeORM 的 `skip/take`，可能会导致 SQL 错误或非预期行为。
因此，我们需要 `class-transformer` 的 `@Type(() => Number)` 配合 `ValidationPipe`，在数据到达 Controller 之前就将其转换为真正的 JavaScript `Number` 类型。

---

## 3. 行动指南 (Action Guide) - 快速开始

### Step 1: 创建通用分页 DTO
**目标**: 定义全站通用的分页参数规范，并在数据层做类型转换。
**文件**: `src/common/dto/pagination.dto.ts`

```typescript
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min, Max } from 'class-validator';

export class PaginationQueryDto {
  @ApiPropertyOptional({
    description: '当前页码 (默认为 1)',
    default: 1,
    example: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number) // 核心：将 URL 字符串 "1" 转换为数字 1
  page: number = 1;

  @ApiPropertyOptional({
    description: '每页条数 (默认为 10)',
    default: 10,
    example: 10,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100) // 安全：防止恶意请求 10000 条数据拖垮数据库
  @Type(() => Number)
  limit: number = 10;
}
```

### Step 2: 改造 Service 层
**目标**: 使用 `findAndCount` 替代 `find`，并计算偏移量。
**文件**: `src/user/user.service.ts`

```typescript
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.mongo.entity';
import { PaginationQueryDto } from '../common/dto/pagination.dto';

@Injectable()
export class UserService {
  // ... 其他构造函数和属性

  async findAll(query: PaginationQueryDto) {
    const { page = 1, limit = 10 } = query;
    const skip = (page - 1) * limit; // 计算数据库偏移量

    // 关键变更：使用 findAndCount 同时获取数据和总数
    const [data, total] = await this.userRepository.findAndCount({
      skip,
      take: limit,
      order: { createdAt: 'DESC' }, // 列表通常需要稳定的排序
    });

    return {
      data, // 当前页数据
      meta: {
        total,      // 数据库总条数
        page,       // 当前页码
        limit,      // 每页条数
        totalPages: Math.ceil(total / limit), // 总页数
      },
    };
  }
}
```

### Step 3: 改造 Controller 层
**目标**: 接收 Query 参数并传递给 Service。
**文件**: `src/user/user.controller.ts`

```typescript
import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { UserService } from './user.service';
import { PaginationQueryDto } from '../common/dto/pagination.dto';

@ApiTags('用户管理')
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  // ... 其他路由方法

  @ApiOperation({ summary: '获取所有用户列表 (分页)' })
  @Get()
  // 使用 @Query() 装饰器将 URL 查询参数映射到 DTO 对象
  findAll(@Query() query: PaginationQueryDto) {
    return this.userService.findAll(query);
  }
}
```
