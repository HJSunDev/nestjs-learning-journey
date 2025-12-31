# 017. RBAC 权限系统设计与实现 (TypeORM + MongoDB)

## 1. 理论体系与核心概念 (Theory & Concepts)

### 1.1 RBAC 模型详解
**RBAC (Role-Based Access Control)** 是一种通过“角色”将“用户”与“权限”逻辑解耦的访问控制策略。其核心思想是：权限授予角色，用户被分配角色，从而继承角色的所有权限。

#### 核心要素
1.  **User (用户)**: 系统的操作主体。
2.  **Role (角色)**: 权限的集合载体，是连接用户与权限的桥梁。
3.  **Permission (权限)**: 对特定资源（Resource）执行特定操作（Operation）的许可。通常细分为：
    *   **功能权限**: 控制菜单、按钮、页面元素的可见性与交互性。
    *   **数据权限**: 控制数据的可见范围（如“仅看本人”、“看本部门”、“看全公司”）。

#### 模型分级
*   **RBAC0 (基础模型)**: 定义了 User、Role、Permission 的基本关系。支持多对多映射（一个用户可拥有多个角色）。
*   **RBAC1 (层级模型)**: 在 RBAC0 基础上引入**角色继承 (Role Hierarchy)**，如“高级管理员”继承“普通管理员”的所有权限。
*   **RBAC2 (约束模型)**: 引入**职责分离 (Separation of Duty)** 等约束，如“出纳”角色不能同时拥有“会计”角色。
*   **RBAC3**: RBAC1 与 RBAC2 的整合。

### 1.2 最佳实践与扩展性
*   **最小权限原则 (Least Privilege)**: 角色仅应包含完成其职责所需的最小权限集。
*   **权限标识规范**: 建议采用 `Resource:Action` 格式（如 `order:create`, `user:delete`）或层级对象结构。
*   **扩展性考量**:
    *   **动态性**: 权限配置应支持运行时修改，而非硬编码在代码中。
    *   **粒度控制**: 随着业务发展，可能需要从“功能级控制”下沉到“字段级控制”（Field-Level Security）。

---

## 2. 本项目落地方案 (System Design)

### 2.1 架构决策
本项目采用 **RBAC0 的简化变体**，并针对 MongoDB 的文档特性进行了特定优化。

*   **关系模型**: User : Role = N : 1。
    *   *设计意图*: 在大多数 SaaS 或中后台系统中，单用户单角色（如“管理员”或“普通成员”）已能覆盖 90% 的场景，且能极大降低鉴权逻辑的复杂度。
*   **存储模型**:
    *   **Permission**: 不设独立表/集合。利用 MongoDB 的 `Document` 特性，将权限配置作为 **Value Object (值对象)** 直接内嵌于 `Role` 实体中。
    *   **User**: 仅存储 `roleId` (ObjectId) 作为外键引用，不存储冗余的角色名称。

### 2.2 功能设计说明

#### 领域模型映射 (Domain Model Mapping)
我们将 RBAC 理论模型中的核心概念直接映射到数据库实体设计中：

1.  **Role (角色) 映射**:
    *   **理论定义**: 连接用户与权限的中间载体。
    *   **代码实现**: 对应 `Role` 实体类。其中 `name` 字段作为角色的唯一标识符 (Identifier)。
2.  **Permission (权限) 映射**:
    *   **理论定义**: 由“资源 (Resource)”与“操作 (Operation)”组成的授权单元。
    *   **代码实现**: 对应 `Role` 实体中的 `permissions` 字段 (JSON Object)。
        *   **Resource**: 映射为对象的 **Key** (如 `users`, `orders`)。
        *   **Operation**: 映射为对象的 **Value** (如 `['read', 'write']`)。
        *   **语义**: Key 与 Value 的组合表达了“允许对某资源执行某操作”的完整权限语义。

#### 技术实现：MongoDB ObjectId 转换机制
MongoDB 驱动层在查询 `_id` 字段时，要求传入的值必须是 BSON 的 `ObjectId` 类型，而不是普通的字符串 `string`。
*   **如果不转换**: 数据库会将传入的字符串 `"63c5..."` 与数据库中二进制存储的 `ObjectId("63c5...")` 进行对比，结果永远是 `false` (不匹配)。
*   **如何转换**: 使用 `mongodb` 原生包提供的 `new ObjectId(idString)` 构造函数。
    *   TypeORM 的 `MongoRepository` 底层依赖 MongoDB 驱动，因此我们在 Service 层必须显式进行这一步转换，再传给 TypeORM 的 `findOneBy` 方法。

#### 设计决策：引用 (Reference) vs 嵌入 (Embed)
*   **嵌入模式 (Embed)**: 如果我们将整个 Role 对象（包含 name, permissions）都存入 User 文档中：
    *   *优点*: 查询 User 时直接就有 Role 信息，速度极快。
    *   *缺点*: **数据冗余与更新困难**。如果你修改了 Admin 角色的权限，你需要遍历数据库中成千上万个 User 文档并更新它们内嵌的 Role 信息。
*   **引用模式 (Reference) [本项目采用]**: User 文档中只存储 `roleId`。
    *   *实现体现*: 代码中的 `@Column() roleId?: ObjectId;` 就是只存了一个 ID 指针。
    *   *“实时生效”原理*:
        1.  管理员修改了 Role 表中的 Admin 角色权限。
        2.  用户 A 发起请求。
        3.  系统通过用户 A 的 `roleId` 去 Role 表**实时查询**最新的 Role 信息。
        4.  此时查到的一定是管理员刚刚修改过的新权限。
        5.  **结论**: 因为数据源只有一份 (Role 表)，所有引用它的 User 都能在下一次查询时自动感知变化，无需同步数据。

### 2.3 关键架构释疑 (Architecture Q&A)

针对 NestJS + TypeORM 架构中常见的概念混淆，这里进行深度辨析。

#### Q1: Entity vs DTO —— 既然字段差不多，为什么要拆分成两个类？

虽然在简单的 CRUD 场景中它们看起来很像，但它们的**职责边界**完全不同：

*   **Entity (实体)**:
    *   **职责**: **对内负责持久化**。它映射的是**数据库的结构**。
    *   **特征**: 包含数据库特有的元数据（如 `@Column`, `@ObjectIdColumn`, 索引定义），以及业务逻辑不需要关心的底层字段（如 `deletedAt`, `version`）。
*   **DTO (数据传输对象)**:
    *   **职责**: **对外负责通信**。它定义的是**API 的契约**。
    *   **特征**: 包含参数校验规则（如 `@IsString`, `@MinLength`）和文档描述（`@ApiProperty`）。
*   **为什么必须分离**:
    *   **安全性**: Entity 可能包含敏感字段（如 `password`, `salt`），如果不分离，直接返回 Entity 给前端极易导致隐私泄露。
    *   **解耦**: 数据库结构变更（Entity 修改）不应直接破坏前端 API 契约（DTO 保持稳定）；反之亦然。

#### Q2: 为什么模块 (Module) 需要导入 Entity？

在 `RoleModule` 中，我们看到了这样的代码：
`imports: [TypeOrmModule.forFeature([Role])]`

*   **根本原因**: **依赖注入 (DI) 的上下文隔离**。
*   **运行机制**:
    1.  TypeORM 核心模块不知道当前模块需要操作哪些表。
    2.  `forFeature([Role])` 相当于发出一道指令：“TypeORM，请为 `Role` 实体初始化一个 `Repository` (数据库操作句柄)，并将其注册到当前模块的 DI 容器中。”
    3.  只有执行了这一步，`RoleService` 中的 `constructor(@InjectRepository(Role) ...)` 才能成功注入依赖。如果省略，NestJS 启动时会报错，因为它找不到能处理 `Role` 的 Repository 提供者。

### 2.4 数据库切换与扩展性分析 (Database Agnosticism Analysis)

关于“当前实现是否与 MongoDB 强绑定”以及“未来迁移 MySQL 的难度”的深度分析。

#### 核心差异与绑定点 (Coupling Points)
尽管 TypeORM 提供了统一的 API，但 NoSQL 与 SQL 的本质差异导致代码中必然存在部分绑定：

1.  **主键类型 (Primary Key)**:
    *   **MongoDB**: 强制使用 `ObjectId` (字符串或对象)。我们在 `CommonMongoEntity` 中使用了 `@ObjectIdColumn()` 和 `ObjectId` 类型。
    *   **MySQL**: 通常使用 `number` (自增 ID) 或 `string` (UUID)。
    *   **风险**: `Service` 层代码中频繁出现的 `new ObjectId(id)` 是强绑定逻辑。
2.  **特有装饰器与类型**:
    *   使用了 `MongoRepository` (包含 `mongo` 特有的聚合操作) 而非通用的 `Repository`。
    *   Entity 中使用了 `@ObjectIdColumn()` 等 Mongo 专用装饰器。
3.  **JSON 数据结构**:
    *   本设计中 Role 的 `permissions` 字段使用了 JSON 对象。虽然 MySQL 5.7+ 也支持 JSON 类型，但 TypeORM 对两者的处理方式略有不同（Mongo 是原生的，MySQL 是序列化存储）。

#### 未来迁移策略 (Migration Strategy)
如果未来需要迁移到 MySQL，并不需要重写所有代码，但需要进行以下重构：

1.  **抽离实体基类**: 创建 `CommonSqlEntity`，将 `_id: ObjectId` 替换为 `id: number/string`。
2.  **Service 层适配**:
    *   移除所有的 `new ObjectId(id)` 转换。
    *   将注入的 `MongoRepository` 替换为标准的 `Repository`。
3.  **关系重构 (Relation Refactoring)**:
    *   MongoDB 中我们手动管理 `roleId`。
    *   MySQL 中建议使用 TypeORM 的 `@ManyToOne` / `@OneToMany` 装饰器来建立物理外键关联，以利用 SQL 的参照完整性约束。

#### 结论
目前的实现**确实与 MongoDB 有一定的耦合**，这是为了充分利用 Mongo 文档特性（如 JSON 权限对象、高性能读写）所做的合理权衡。TypeORM 并没有完全抹平这些差异。但得益于 NestJS 的分层架构（Controller -> Service -> Repository），**业务逻辑的核心流程是通用的**，迁移成本主要集中在 Entity 定义和 Service 层的数据转换上，是可控的。

---

## 3. 行动指南 (Action Guide)

本章节提供完整的代码实现，可直接用于构建 RBAC 模块。

### Step 1: 定义角色实体 (Role Entity)

**设计说明**:
这里利用 MongoDB 的 Schema-less 特性，使用 `@Column()` 直接存储 JSON 格式的权限对象，避免了传统 SQL 中需要建立 `role_permissions` 中间表的繁琐操作。

```typescript
// src/role/entities/role.mongo.entity.ts
import { Entity, Column } from 'typeorm';
import { CommonMongoEntity } from '../../common/entities/common.mongo.entity';

@Entity('roles')
export class Role extends CommonMongoEntity {
  @Column({ unique: true })
  name: string;

  /**
   * 权限配置
   * 采用 Map 结构存储，便于快速查找 (O(1) 复杂度)
   * 格式示例:
   * {
   *   "user_management": ["create", "read", "update", "delete"],
   *   "order_processing": ["read", "audit"]
   * }
   */
  @Column()
  permissions: Record<string, string[]>;
}
```

### Step 2: 定义 DTO 与校验规则

**设计说明**:
使用 `class-validator` 确保入参的合法性，特别是 `permissions` 字段必须符合预期的对象结构。

```typescript
// src/role/dto/create-role.dto.ts
import { IsString, IsNotEmpty, IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateRoleDto {
  @ApiProperty({ description: '角色名称', example: 'System Admin' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: '权限集合 Key为资源模块，Value为操作数组',
    example: { user: ['read', 'write'], content: ['publish'] },
  })
  @IsObject()
  permissions: Record<string, string[]>;
}
```

```typescript
// src/role/dto/update-role.dto.ts
import { PartialType } from '@nestjs/swagger';
import { CreateRoleDto } from './create-role.dto';

export class UpdateRoleDto extends PartialType(CreateRoleDto) {}
```

### Step 3: 实现业务逻辑 (Service)

**设计说明**:
实现标准的 CRUD 操作。注意 MongoDB 的 `_id` 是 `ObjectId` 类型，在查询时必须进行类型转换，否则无法匹配。

```typescript
// src/role/role.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MongoRepository } from 'typeorm';
import { ObjectId } from 'mongodb';
import { Role } from './entities/role.mongo.entity';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

@Injectable()
export class RoleService {
  constructor(
    @InjectRepository(Role)
    private readonly roleRepository: MongoRepository<Role>,
  ) {}

  async create(createRoleDto: CreateRoleDto): Promise<Role> {
    const role = this.roleRepository.create(createRoleDto);
    return await this.roleRepository.save(role);
  }

  async findAll(): Promise<Role[]> {
    return await this.roleRepository.find();
  }

  async findOne(id: string): Promise<Role> {
    // 关键点：String -> ObjectId 转换
    const objectId = new ObjectId(id);
    const role = await this.roleRepository.findOneBy({ _id: objectId });
    if (!role) {
      throw new NotFoundException(`Role with ID ${id} not found`);
    }
    return role;
  }

  async update(id: string, updateRoleDto: UpdateRoleDto): Promise<Role> {
    // 复用 findOne 确保存在性检查
    const role = await this.findOne(id);
    // Merge 操作会将 DTO 中的非空字段覆盖到实体上
    this.roleRepository.merge(role, updateRoleDto);
    return await this.roleRepository.save(role);
  }

  async remove(id: string): Promise<void> {
    const objectId = new ObjectId(id);
    const result = await this.roleRepository.delete(objectId);
    if (result.affected === 0) {
      throw new NotFoundException(`Role with ID ${id} not found`);
    }
  }
}
```

### Step 4: 实现控制器 (Controller)

**设计说明**:
暴露 RESTful API 接口，并集成 Swagger 文档注解。

```typescript
// src/role/role.controller.ts
import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { RoleService } from './role.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

@ApiTags('roles')
@Controller('roles')
export class RoleController {
  constructor(private readonly roleService: RoleService) {}

  @Post()
  @ApiOperation({ summary: '创建角色' })
  create(@Body() createRoleDto: CreateRoleDto) {
    return this.roleService.create(createRoleDto);
  }

  @Get()
  @ApiOperation({ summary: '获取角色列表' })
  findAll() {
    return this.roleService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: '获取角色详情' })
  findOne(@Param('id') id: string) {
    return this.roleService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '更新角色' })
  update(@Param('id') id: string, @Body() updateRoleDto: UpdateRoleDto) {
    return this.roleService.update(id, updateRoleDto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除角色' })
  remove(@Param('id') id: string) {
    return this.roleService.remove(id);
  }
}
```

### Step 5: 模块注册 (Module)

**设计说明**:
将 Entity 注册到 TypeORM，并将 Service 导出以便其他模块（如 AuthModule）后续调用。

```typescript
// src/role/role.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RoleService } from './role.service';
import { RoleController } from './role.controller';
import { Role } from './entities/role.mongo.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Role])],
  controllers: [RoleController],
  providers: [RoleService],
  exports: [RoleService], // 导出 Service 供鉴权守卫使用
})
export class RoleModule {}
```

### Step 6: 建立用户与角色的关联

**设计说明**:
在 User 实体中添加 `roleId` 字段。

```typescript
// src/user/entities/user.mongo.entity.ts
import { Entity, Column } from 'typeorm';
import { ObjectId } from 'mongodb';
import { CommonMongoEntity } from '../../common/entities/common.mongo.entity';

@Entity('users')
export class User extends CommonMongoEntity {
  @Column()
  name: string;

  @Column()
  email: string;

  @Column()
  password: string;

  /**
   * 角色引用 ID
   * 关联方式: Manual Reference (手动引用)
   * 
   * 在业务层通过 RoleService.findOne(user.roleId) 获取详细权限，
   * 或在 MongoDB 聚合查询中使用 $lookup 进行联表。
   */
  @Column()
  roleId?: ObjectId;
}
```

### Step 7: 全局注册模块

**设计说明**:
最后，确保 `RoleModule` 被添加到应用的根模块中。

```typescript
// src/app.module.ts
import { Module } from '@nestjs/common';
// ... 其他导入
import { RoleModule } from './role/role.module';

@Module({
  imports: [
    // ... 其他模块
    RoleModule, // 注册 RoleModule
    UserModule,
  ],
  // ...
})
export class AppModule {}
```
