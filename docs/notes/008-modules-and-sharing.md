# 008. NestJS 模块化 (Modules) 与共享策略

## 1. 核心问题与概念 (The "Why")

- **解决什么问题**: 
  - **代码组织混乱**: 如果所有服务都堆在 `AppModule`，应用变大后会变成不可维护的“大泥球”。
  - **边界不清**: 无法明确哪些功能是公开的，哪些是私有的。
  - **复用困难**: 难以将通用的功能（如加密、日志、配置）在不同业务板块间共享。

- **核心概念**:
  - **Module (模块)**: NestJS 应用的组织单元。它像一个“集装箱”，把相关的 Controller、Service 和实体打包在一起。
  - **Encapsulation (封装)**: 默认情况下，模块内部的 Provider 是**私有的**。除非显式导出，否则其他模块无法使用。
  - **Shared Module (共享模块)**: 专门设计用来被其他模块导入的模块（通常放入 `common` 或 `libs` 目录）。

---

## 2. 深度原理与机制 (Under the Hood)

### 2.1 模块解析流程
NestJS 的依赖注入系统是基于**模块上下文**的。

1. **扫描 Imports**: 当 Nest 解析 `UserModule` 时，发现它导入了 `HashingModule`。
2. **加载依赖模块**: 容器先加载 `HashingModule`。
3. **识别 Exports**: 容器查看 `HashingModule` 的 `exports` 数组。只有在 exports 列表里的 Provider（如 `HashingService`），才会被放入“公共池”。
4. **注入**: 当 `UserService` 请求注入 `HashingService` 时，容器会在 `UserModule` 的作用域内查找。如果找不到，它会去查看导入模块的“公共池”。

**图解模块通信**:
`UserModule` ➡️ imports ➡️ `HashingModule` ⬅️ exports ⬅️ `HashingService`

### 2.2 四大属性详解 (`@Module`)

```typescript
@Module({
  // 1. providers: 只有这里的类才能被实例化
  providers: [MyService],
  
  // 2. controllers: 定义该模块处理哪些路由
  controllers: [MyController],
  
  // 3. imports: 导入其他模块（不仅是类，必须是 Module）
  // 只有导入了 ModuleB，ModuleB 导出的东西才能在这里用
  imports: [ModuleB],
  
  // 4. exports: 决定哪些 Provider 可以被其他模块使用
  // 如果不写在 exports 里，别的模块就算 import 了当前模块也用不了 MyService
  exports: [MyService] 
})
export class MyModule {}
```

---

## 3. 实战代码演示 (Code in Action)

**场景**: 我们将通用的密码加密逻辑封装为 `HashingModule`，并在 `UserModule` 中使用它。

### 步骤 1: 创建共享模块 (The Provider)

首先定义服务，然后将其**装箱**并**导出**。

```typescript
// src/common/hashing/hashing.service.ts
@Injectable()
export class HashingService {
  async hash(data: string) { /* ...bcrypt impl... */ }
}

// src/common/hashing/hashing.module.ts
@Module({
  providers: [HashingService], // 1. 注册: 允许在模块内部实例化
  exports: [HashingService],   // 2. 导出: 允许外部模块使用这个实例
})
export class HashingModule {}
```

### 步骤 2: 导入并使用 (The Consumer)

在业务模块中导入共享模块。

```typescript
// src/user/user.module.ts
import { HashingModule } from '../common/hashing/hashing.module';

@Module({
  imports: [HashingModule], // 3. 导入: 建立模块间的依赖关系
  providers: [UserService],
  // ...
})
export class UserModule {}
```

### 步骤 3: 依赖注入 (Injection)

现在，`UserService` 就可以像使用本地服务一样使用 `HashingService` 了。

```typescript
// src/user/user.service.ts
@Injectable()
export class UserService {
  // Nest 会自动解析，发现 HashingService 来自导入的 HashingModule
  constructor(private readonly hashingService: HashingService) {}

  async register(dto: CreateUserDto) {
    const safePassword = await this.hashingService.hash(dto.password);
    // ... save user
  }
}
```

---

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

- ✅ **Shared Module 目录结构**: 建议将通用模块放在 `src/common` 或 `src/shared` 目录下，与业务模块（如 `user`, `order`）区分开。
- ✅ **显式导出**: 永远要记住，模块默认是封闭的。如果你写了 Service 但别的模块报错 `Nest can't resolve dependencies`，99% 是因为你忘了在定义该 Service 的模块里写 `exports`。
- ❌ **直接导入 Service 类**: 严禁在 `imports` 数组里直接写 Service 类（如 `imports: [AuthService]`）。`imports` 只能放 Module 类。
- ❌ **Global Module 滥用**: 虽然可以用 `@Global()` 让模块变成全局（无需 import），但这会破坏依赖关系的清晰度。除非是数据库连接或全局配置，否则尽量显式 import。

---

## 5. 行动导向 (Action Guide)

**(类型 C: 方案实现) -> 提取通用逻辑为共享模块**

- [Step 1] **识别通用逻辑**: 发现代码中重复的部分（如上传文件、发送邮件）。
- [Step 2] **生成模块**: `nest g module common/email` & `nest g service common/email`。
- [Step 3] **配置导出**: 在 `email.module.ts` 的 `exports` 数组中添加 `EmailService`。
- [Step 4] **消费模块**: 在需要发邮件的 `OrderModule` 中 `imports: [EmailModule]`。

