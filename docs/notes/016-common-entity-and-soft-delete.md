# 016. 通用实体与软删除 (Common Entity & Soft Delete)

## 1. 核心问题与概念 

### 解决痛点
1.  **代码冗余 (DRY Violation)**: 几乎每个业务表都需要 `id`, `createdAt`, `updatedAt`, `version`, `deletedAt` 这 5 个字段。如果在每个 Entity 文件中重复定义，代码维护成本极高。
2.  **数据安全风险**:
    -   **物理删除 (Hard Delete)**: 传统的 SQL `DELETE` 会永久抹除数据。一旦误删，除非回滚整个数据库备份，否则无法恢复。
    -   **并发覆盖 (Lost Update)**: 多人同时修改同一条记录时，后提交的会覆盖先提交的。
3.  **命名规范不统**: 容易出现 `create_time` vs `createdAt` 的混乱。

---

## 2. 深度解析：技术方案与原理 (Deep Dive)

### 方案 A: 继承式架构与 `abstract class` (Inheritance)

#### 1. 抽象类 (Abstract Class) 核心概念
-   **定义**: `abstract class` 是 TypeScript 中的一种特殊类，**不能被实例化**，仅用于定义子类的通用结构和行为。
-   **TypeORM 映射机制**: 当使用 `@Entity` 的子类继承 `abstract class` 时，TypeORM 不会在数据库中创建父类表，而是将父类中定义的列（Column）**合并**到子类表中。这实现了"一张表包含所有通用字段"的物理结构，同时保持代码层面的逻辑分离。

#### 2. 使用场景与规范
-   **Is-A 关系**: 适用于所有业务实体都共享的基础元数据（如 ID、时间戳）。
-   **强制契约**: 虽然本例仅复用字段，但抽象类也可定义抽象方法 (`abstract method`)，强制所有子类必须实现特定逻辑（如 `toJSON` 序列化规则）。

```typescript
// 错误用法：尝试直接 new 抽象类
const entity = new CommonMongoEntity(); // ❌ 编译错误

// 正确用法：实例化继承了抽象类的子类
const user = new User(); // ✅ 合法
```

### 方案 B: 物理删除 vs 软删除 (Hard vs Soft Delete)

| 特性               | 物理删除 (repo.delete)                 | 软删除 (repo.softDelete)                                     |
| :----------------- | :------------------------------------- | :----------------------------------------------------------- |
| **SQL 行为** | `DELETE FROM users WHERE id = 'xxx'` | `UPDATE users SET deletedAt = NOW() WHERE id = 'xxx'`      |
| **数据状态** | 永久从磁盘移除                         | 依然在磁盘中，只是 `deletedAt` 字段有值                    |
| **查询影响** | 彻底查不到了                           | `find()` 默认会自动加上 `AND deletedAt IS NULL` 过滤掉它 |
| **恢复能力** | ❌ 无法恢复                            | ✅ 可通过 `repo.restore(id)` 瞬间恢复                      |
| **审计能力** | ❌ 丢失所有痕迹                        | ✅ 保留了"何时被删除"的时间戳                                |

### 方案 C: 乐观锁实现原理 (Optimistic Locking)

#### 1. `@VersionColumn` 装饰器机制
TypeORM 提供的 `@VersionColumn` 装饰器通过**数据库层面的原子性检查**来实现乐观锁，无需在 Service 层编写比较逻辑。

#### 2. 自动版本检测流程
当执行 `repository.save(entity)` 或 `update` 时，TypeORM 会自动构建包含版本检查的 SQL 语句。

**SQL 执行逻辑示例**:
```sql
UPDATE users 
SET name = 'New Name', version = 2 
WHERE id = 1 AND version = 1  -- 核心：不仅匹配 ID，还必须匹配读取时的版本号
```

-   **匹配成功 (Affected Rows = 1)**: 说明数据库中的数据未被他人修改，更新成功，版本号自动 +1。
-   **匹配失败 (Affected Rows = 0)**: 说明 `version` 已经被其他事务修改（例如变成了 2），此时 `WHERE` 条件不成立。
-   **异常抛出**: TypeORM 检测到受影响行数为 0，自动抛出 `OptimisticLockVersionMismatchError`。

---

## 3. 架构扩展性思考 (Architecture & Scalability)

### 数据库乐观锁 vs Redis 分布式锁

在系统演进过程中，我们常会遇到 "Version 字段锁" 与 "Redis 分布式锁" 的选型疑惑。两者并非互斥，而是应用于不同层级的互补方案。

#### 1. 层级定位差异
-   **数据库乐观锁 (`@VersionColumn`)**: 
    -   **定位**: **数据持久层 (Data Layer)** 的最后一道防线。
    -   **作用域**: 保证单行记录在数据库写入时的原子性。无论上层服务有多少个实例，只要最终写入同一个数据库，该机制均有效。
    -   **成本**: 极低。仅需一个整数字段，无额外基础设施依赖。
-   **Redis 分布式锁**:
    -   **定位**: **业务逻辑层 (Service Layer)** 的并发控制。
    -   **作用域**: 跨进程/跨服务的资源互斥（如："每分钟只能有一个节点执行定时任务"、"秒杀活动拦截流量"）。
    -   **成本**: 较高。需要维护 Redis 基础设施及处理锁超时、死锁等复杂逻辑。

#### 2. 演进路线图
-   **当前阶段 (单体/小规模集群)**: 仅使用 `@VersionColumn` 即可完美处理用户编辑冲突等常规并发问题。
-   **未来阶段 (微服务/高并发)**: 
    -   当面临秒杀等高吞吐场景时，数据库层面的重试成本过高。
    -   此时可在 Service 层引入 Redis 分布式锁作为前置拦截。
    -   **结论**: 引入 Redis 锁不需要修改现有的 Entity 结构，`version` 字段依然作为到底层的安全兜底，两者完美共存，互不冲突。

---

## 4. 行动指南 (Action Guide) - 快速开始

### Step 1: 创建通用实体基类
**目标**: 定义全站统一的元数据字段。
**文件**: `src/common/entities/common.mongo.entity.ts`

```typescript
import { 
  ObjectIdColumn, 
  ObjectId, 
  CreateDateColumn, 
  UpdateDateColumn, 
  DeleteDateColumn,
  VersionColumn 
} from 'typeorm';

export abstract class CommonMongoEntity {
  // 1. 统一主键：MongoDB 使用 ObjectId
  @ObjectIdColumn()
  _id: ObjectId;

  // 2. 创建时间：插入时自动赋值
  @CreateDateColumn({ type: 'timestamp' })
  createdAt: Date;

  // 3. 更新时间：每次 save/update 自动更新
  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt: Date;

  // 4. 软删除时间戳：TypeORM 查操作会自动过滤非 null 值
  @DeleteDateColumn({ type: 'timestamp' })
  deletedAt: Date;

  // 5. 乐观锁版本号：每次更新自动 +1，框架自动校验冲突
  @VersionColumn({ select: false })
  version: number;
}
```

### Step 2: 业务实体继承
**目标**: 让业务实体复用基类能力。
**文件**: `src/user/entities/user.mongo.entity.ts`

```typescript
import { Entity, Column } from 'typeorm';
import { CommonMongoEntity } from '../../common/entities/common.mongo.entity';

@Entity('users')
// 关键：继承 CommonMongoEntity
export class User extends CommonMongoEntity {
  @Column()
  name: string;

  @Column()
  email: string;

  @Column()
  password: string;
  // 无需再写 _id, createdAt 等字段
}
```

### Step 3: Service 层逻辑升级
**目标**: 切换到软删除 API，并移除手动时间戳赋值。
**文件**: `src/user/user.service.ts`

```typescript
// ... imports

@Injectable()
export class UserService {
  // ... constructor

  async create(createUserDto: CreateUserDto) {
    // 变更：不再需要手动赋值 createdAt, updatedAt
    // TypeORM 的 @CreateDateColumn 会自动处理
    const newUser = this.userRepository.create({
      ...createUserDto,
      password: hashedPassword,
    });
    return await this.userRepository.save(newUser);
  }

  async remove(id: string) {
    if (!ObjectId.isValid(id)) {
      throw new NotFoundException(`Invalid ID format`);
    }
  
    // 变更：使用 softDelete 替代 delete
    // 这将执行 UPDATE 操作而不是 DELETE 操作
    const result = await this.userRepository.softDelete(id);
  
    if (result.affected === 0) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }
    return { deleted: true };
  }
  
  // 查询方法 findAll/findOne 无需改动
  // TypeORM 会自动过滤掉 deletedAt 有值的记录
}
```
