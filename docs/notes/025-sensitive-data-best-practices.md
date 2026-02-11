# 025. 敏感数据处理最佳实践 (Sensitive Data Handling)

## 1. 核心说明 (Explanation)

### 1.1 核心概念解析

在实施敏感数据处理之前，需要理解 NestJS 框架中的几个关键技术组件：

*   **Reflector (反射器)**
    *   **定义**：NestJS 提供的辅助类，用于在运行时读取类、方法或属性上的元数据（Metadata）。
    *   **作用**：在序列化过程中，系统需要知道哪些字段被标记了 `@Exclude` 或 `@Expose`。`Reflector` 就是负责读取这些装饰器信息的“读取器”。
    *   **代码体现**：`app.get(Reflector)` 是从 IoC 容器中获取全局唯一的 `Reflector` 实例。

*   **ClassSerializerInterceptor (类序列化拦截器)**
    *   **定义**：NestJS 官方提供的拦截器，基于 `class-transformer` 库实现。
    *   **作用**：它拦截 Controller 返回的响应数据，根据数据对象上的装饰器规则（如 `@Exclude`），将其转换为最终的 JSON 格式。如果不使用它，对象会直接按原样输出。
    *   **代码体现**：`new ClassSerializerInterceptor(app.get(Reflector))` 实例化这个拦截器，并将反射器注入其中，使其具备读取装饰器的能力。

*   **useGlobalInterceptors (全局拦截器注册)**
    *   **定义**：`INestApplication` 接口提供的方法，用于注册应用级别的拦截器。
    *   **作用**：一旦注册，该拦截器会对整个应用的所有路由生效。
    *   **代码体现**：`app.useGlobalInterceptors(...)` 确保所有接口的返回值都会自动经过序列化处理，无需每个 Controller 单独配置。

### 1.2 为什么引入 Response DTO？

引入 **UserResponseDto** 的核心目的是实现 **安全契约**：

1.  **安全隔离**：Entity 是数据库的映射，包含 `password` 等敏感数据；DTO 是 API 的契约，只包含前端需要的数据。
2.  **按需返回**：通过 DTO 可以灵活定义返回结构（如 `UserAdminDto` 和 `UserPublicDto`）。

### 1.3 敏感信息处理机制：白名单 (Whitelist) vs 黑名单 (Blacklist)

在 DTO 序列化中，理解 `class-transformer` 的默认行为至关重要：

> **⚠️ 默认行为 (Default Behavior)**：
> 如果 DTO 类上**没有**添加 `@Exclude()` 装饰器，且属性上也没有 `@Exclude` 或 `@Expose`，系统默认采用 `exposeAll` 策略。
> 这意味着：**源对象（Entity）中的所有字段都会被原样返回**，无论它们是否在 DTO 中定义。这与 Request DTO 的校验逻辑（自动剔除未定义字段）完全相反，极易导致敏感数据泄露。

基于此，有两种核心策略：

#### 策略 A：白名单机制 (Whitelist) - **[强烈推荐]**
*   **做法**：在 DTO 类上添加 `@Exclude()` 装饰器。
*   **规则**：**“默认全扔掉，只有标了 `@Expose` 的才保留”**。
*   **未定义字段的处理**：如果你在 DTO 里完全没写 `password` 字段，或者写了但没加 `@Expose`，它**绝对不会**被返回。
*   **优点**：
    *   **极致安全**：即使数据库新增了一个“身份证号”字段，因为你忘了在 DTO 里加 `@Expose`，它也默认不返回，避免了“默认泄露”的风险。
    *   **契约明确**：看 DTO 里的 `@Expose` 就知道接口返回什么。
*   **缺点**：有些麻烦，需要把所有要返回的字段都列一遍。

#### 策略 B：黑名单机制 (Blacklist)
*   **做法**：**不**在 DTO 类上加 `@Exclude()`。
*   **规则**：**“默认全保留，只有标了 `@Exclude` 的才扔掉”**。
*   **未定义字段的处理**：`class-transformer` 默认会把源对象 (Entity) 里的所有属性都拷贝到结果里，除非你显式排除了它。
*   **优点**：省事，只写不想返回的。
*   **缺点**：**极度危险**。如果你给 User 表加了个 `salary` 字段，忘了在 DTO 里加 `@Exclude`，它就直接泄露给前端了。

**结论：**
为了安全起见，**工业界严选“白名单机制”**。虽然写起来稍微繁琐（需要把所有返回字段都写上），但它能防止“因遗忘导致的泄露”。

---

## 2. 行动指南 (Action Guide)

本指南采用 **白名单策略** 实现敏感数据自动过滤。

### Step 1: 启用全局序列化拦截器

**位置**: `src/main.ts`

```typescript
import { NestFactory, Reflector } from '@nestjs/core';
import { ClassSerializerInterceptor } from '@nestjs/common';
// ... 其他 import

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // [新增] 注册全局序列化拦截器
  // 依赖 Reflector 来读取 DTO 上的元数据
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  await app.listen(3000);
}
bootstrap();
```

### Step 2: 定义安全的 Response DTO

**位置**: `src/user/dto/user-response.dto.ts`

**操作**: 创建一个 DTO 类，使用 `@Exclude` 开启白名单模式，仅暴露需要的字段。即使 `password` 字段在 Entity 中存在，因为这里没写且开启了白名单，它会被自动丢弃。

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { Exclude, Expose, Transform } from 'class-transformer';
import { ObjectId } from 'mongodb';

/**
 * 用户响应 DTO
 * 策略：使用 @Exclude() 开启白名单模式。
 * 规则：DTO 中未提及的字段，或提及但未标记 @Expose 的字段，统统不返回。
 */
@Exclude()
export class UserResponseDto {
  @ApiProperty({ description: '用户ID', example: '65a0c...' })
  @Expose()
  @Transform(({ value }) => value?.toString(), { toPlainOnly: true })
  _id: string;

  @ApiProperty({ description: '用户昵称' })
  @Expose()
  name: string;

  @ApiProperty({ description: '手机号' })
  @Expose()
  phoneNumber: string;

  // Q: 为什么不用写 password?
  // A: 因为类头部的 @Exclude() 已经声明了"默认全部隐藏"。
  //    既然这里压根没提 password，它自然就被隐藏了。

  constructor(partial: Partial<UserResponseDto>) {
    Object.assign(this, partial);
  }
}
```

### Step 3: 在 Controller 中应用 DTO

**位置**: `src/user/user.controller.ts`

```typescript
import { UserResponseDto } from './dto/user-response.dto';
import { plainToInstance } from 'class-transformer';

// ... 

@ApiOperation({ summary: '创建新用户' })
@ApiResponse({ status: 201, type: UserResponseDto }) 
@Post()
async create(@Body() createUserDto: CreateUserDto) {
  // 1. 获取包含敏感信息的原始 Entity
  const user = await this.userService.create(createUserDto);
  
  // 2. 转换为 DTO，此时敏感字段被自动剔除
  return new UserResponseDto(user);
}
```
