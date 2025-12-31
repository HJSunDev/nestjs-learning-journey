# 018. 敏感信息加密与密码加盐 (Hashing & Salting)

## Part 1: 技术原理与方案演进 (Explanation)

### 1.1 核心概念：哈希与加盐

**哈希 (Hashing)** 是一种单向加密技术，它将任意长度的输入（如密码）转换为固定长度的输出（摘要）。与双向加密（如 AES）不同，哈希是**不可逆**的。

**为什么要加盐 (Salting)？**
仅仅使用哈希（如 MD5 或 SHA-256）是不够的，因为攻击者可以利用 **彩虹表**（预先计算好的密码-哈希对照表）瞬间破解常见密码。
*   **机制**：在密码哈希过程中加入一段随机字符串（盐）。
*   **效果**：即使两个用户使用相同的密码 "123456"，因为盐不同，生成的哈希值也完全不同。这迫使攻击者必须针对每个用户单独计算彩虹表，使其攻击成本呈指数级上升。

---

### 1.2 方案 A：传统手动加盐 (Node.js Crypto)

这是基于 Node.js 原生 `crypto` 模块的手动实现方案。

**工作流程**:
1.  **生成盐**: 使用 `crypto.randomBytes` 生成随机盐。
2.  **计算哈希**: 使用 `crypto.pbkdf2` 将密码和盐混合计算出哈希值。
3.  **存储**: **必须**在数据库中同时存储 **哈希值** 和 **盐值**。

**局限性**:
*   **架构冗余**: 需要在 User 表中专门维护 `salt` 字段。
*   **安全性风险**: 开发者需要自行决策迭代次数、密钥长度等参数，容易因配置不当留下安全隐患。

---

### 1.3 方案 B：现代标准方案 (Bcrypt) —— **本项目采用**

**Bcrypt** 是目前业界标准的密码哈希算法，它解决了手动加盐方案的痛点。

**Bcrypt 的核心优势**:
1.  **内置盐管理**: 自动生成随机盐，并将其直接编码在最终的哈希字符串中。
2.  **自适应安全性**: 通过调整 `cost factor` (工作因子)，可以随着硬件性能提升而增加计算难度，有效抵御暴力破解。
3.  **架构简洁**: 数据库仅需存储一个字符串，无需维护额外的 `salt` 字段。

#### 深度解析：为什么不需要单独存储 Salt？

这是因为 Bcrypt 生成的哈希字符串本身就是一个**结构化数据**。

**哈希结构示例**: `$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy`

| 部分 | 值 | 含义 |
| :--- | :--- | :--- |
| **算法标识** | `$2a$` | 表示这是一个 Bcrypt 哈希。 |
| **成本因子** | `$10$` | 表示进行了 $2^{10}$ (1024) 次密钥扩展迭代。 |
| **盐 (Salt)** | `N9qo8uLOickgx2ZMRZoMye` | 前 22 个字符是真实使用的随机盐（Base64编码）。 |
| **哈希内容** | `IjZAgcfl7p92ldGxad68LJZdL17lhWy` | 剩余部分是实际的哈希摘要。 |

**校验原理 (Compare)**:
当调用 `bcrypt.compare(password, hash)` 时，算法会：
1.  解析 `hash` 字符串，提取出其中的 **成本因子** 和 **盐**。
2.  使用提取出的参数，对输入的 `password` 进行完全相同的哈希运算。
3.  将运算结果与 `hash` 字符串中的 **哈希内容** 部分进行比对。

这就是为什么我们不需要在数据库中单独存储盐，也不需要在校验时显式传递它的原因。

---

## Part 2: 行动指南 (Action Guide)

### Step 1: 安装依赖

确保安装了 `bcryptjs` (纯 JS 实现) 及其类型定义。

```bash
npm install bcryptjs
npm install -D @types/bcryptjs
```

### Step 2: 检查实体定义 (Entity)

由于 Bcrypt 将盐包含在哈希值中，User 实体**不需要** `salt` 字段。

```typescript
// src/user/entities/user.mongo.entity.ts
@Entity('users')
export class User extends CommonMongoEntity {
  // ...
  @Column()
  password: string; // 仅存哈希值
  // ...
}
```

### Step 3: 创建并导出 HashingModule

我们需要将哈希服务封装在独立的模块中，以便其他模块复用。

**文件**: `src/common/hashing/hashing.service.ts`

```typescript
import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class HashingService {
  private readonly saltRounds = 10;

  /**
   * 对纯文本进行哈希处理
   * @param plainText 原始文本（如密码）
   * @returns 哈希后的字符串
   */
  async hash(plainText: string): Promise<string> {
    return bcrypt.hash(plainText, this.saltRounds);
  }

  /**
   * 比对纯文本与哈希值是否匹配
   * @param plainText 原始文本
   * @param hash 哈希值
   * @returns 是否匹配
   */
  async compare(plainText: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plainText, hash);
  }
}
```

**文件**: `src/common/hashing/hashing.module.ts`

```typescript
import { Module } from '@nestjs/common';
import { HashingService } from './hashing.service';

@Module({
  providers: [HashingService],
  exports: [HashingService], // 关键：导出服务，使其对导入此模块的其他模块可见
})
export class HashingModule {}
```

### Step 4: 在 UserModule 中集成

在需要使用哈希功能的模块中导入 `HashingModule`。

> **Q: 为什么不将 HashingModule 导入到 AppModule?**
>
> 这是一个常见的设计问题。在 NestJS 中，我们将模块分为两类：
> 1.  **全局核心模块 (Global/Core Modules)**: 如 `ConfigModule` (配置)、`LoggerModule` (日志)、`DatabaseModule` (数据库)。它们是**基础设施**，几乎每个模块都需要，或者需要在应用启动时立即初始化。这类模块通常在 `AppModule` 中导入，甚至使用 `@Global()` 装饰器标记为全局模块。
> 2.  **功能共享模块 (Shared/Feature Modules)**: 如 `HashingModule`。虽然它是通用的，但**并非所有模块都需要它**（例如，ProductModule 或 OrderModule 可能根本不需要处理密码）。
>
> **最佳实践**: **按需导入 (Import on Demand)**。这也遵循了“关注点分离”和“最小权限”原则。只有真正需要哈希功能的 `UserModule` 或 `AuthModule` 才应该导入它。这样可以保持依赖关系清晰，避免 AppModule 变得臃肿。

**文件**: `src/user/user.module.ts`

```typescript
import { HashingModule } from '../common/hashing/hashing.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User]), 
    HashingModule, // 导入 HashingModule
  ],
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}
```

### Step 5: 在 UserService 中使用

通过依赖注入使用 `HashingService` 处理密码。

**文件**: `src/user/user.service.ts`

```typescript
import { HashingService } from '../common/hashing/hashing.service';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly hashingService: HashingService, // 注入服务
  ) {}

  async create(createUserDto: CreateUserDto) {
    // 1. 加密
    const hashedPassword = await this.hashingService.hash(createUserDto.password);
    
    // 2. 创建 (使用 hash)
    const newUser = this.userRepository.create({
      ...createUserDto,
      password: hashedPassword, 
    });

    return await this.userRepository.save(newUser);
  }
  
  // Update 逻辑同理...
}
```
