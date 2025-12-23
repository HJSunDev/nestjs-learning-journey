# 006. 管道(Pipe)与数据校验

## 1. 背景与需求 (Context & Requirements)

- **场景**: 控制器接收到的数据是不可信的（可能是空的、乱码的、恶意的）。
- **目标**: 在数据真正进入 Controller 业务逻辑之前，自动完成**类型转换**和**数据校验**。如果不符合规则，直接抛出 400 错误，让 Controller 拿到永远是干净的数据。

## 2. 核心概念 (Core Concepts)

### 2.1 Pipe 是什么 (原理)

不要把它想象成抽象的管道。**Pipe 本质上就是一个拦截函数**。

它夹在 **HTTP 请求解析** 和 **Controller 方法调用** 之间。

1. **输入**: 原始参数（Body, Query, Param）。
2. **处理**:
   - **转换 (Transformation)**: 把字符串 "1" 变成数字 1。
   - **验证 (Validation)**: 检查是否有 email 字段，格式对不对。
3. **输出**:
   - 如果通过：返回处理后的值传给 Controller。
   - 如果失败：直接抛异常，请求结束。

### 2.2 ValidationPipe 的工作机制

NestJS 内置的 `ValidationPipe` 结合了两个库来工作：

1. **class-transformer**: 把普通的 JSON 对象（纯数据）转换成 **类 (Class) 的实例**。
2. **class-validator**: 扫描这个类实例上的 **装饰器**（如 `@IsEmail`），执行校验逻辑。

**只有 DTO 是 Class，这套机制才能跑通，这就是上一章强调 DTO 必须是 Class 的根本原因。**

### 2.3 深入原理：PipeTransform 接口

在 NestJS 中，所有的管道都必须实现 `PipeTransform` 接口。这是一个非常简单的契约：

```typescript
// 伪代码演示 NestJS 内部原理
export interface PipeTransform<T = any, R = any> {
  transform(value: T, metadata: ArgumentMetadata): R;
}
```

每当一个请求到达 Controller 之前，NestJS 都会调用这个 `transform` 方法：

1. **value**: 当前处理的参数值（例如前端传来的整个 Body 对象）。
2. **metadata**: 关于这个参数的元数据（它是 Body 还是 Query？它的 TS 类型是什么？）。

### 2.4 底层架构：AOP 与责任链详解 (Deep Dive)

NestJS 的管道机制采用了经典的 **责任链模式 (Chain of Responsibility)** 与 **AOP (面向切面编程)** 思想。

#### 1. 注册阶段 (Registration)

当我们在 `main.ts` 中调用 `app.useGlobalPipes(new ValidationPipe())` 时：

- NestJS 应用实例内部维护了一个 `GlobalPipes` 数组。
- `ValidationPipe` 的实例被推入这个数组中，但此时它还未执行，只是被**挂载**到了全局上下文中。

#### 2. 执行阶段 (Execution Flow)

当一个 HTTP 请求到达某个具体的路由处理函数（Handler）前，NestJS 核心会动态组装一条“执行链”：

**A. 管道链组装 (Chain Assembly)**
系统会按顺序收集以下四个维度的管道，合并成一个列表：

1. **全局管道** (Global): `app.useGlobalPipes()`
2. **控制器管道** (Controller): `@UsePipes()` on Class
3. **方法管道** (Method): `@UsePipes()` on Method
4. **参数管道** (Param): `@Body(new Pipe())`

**B. 链式调用 (Sequential Execution)**
NestJS 使用类似 `reduce` 的机制让数据流过这些管道：

```javascript
// 伪代码：模拟 NestJS 内部的管道执行逻辑
async function runPipes(pipes, initialData) {
  let result = initialData;
  
  for (const pipe of pipes) {
    // 每一个管道的输出，直接成为下一个管道的输入
    result = await pipe.transform(result); 
  }
  
  return result; // 最终结果传给 Controller
}
```

#### 3. 异常熔断机制 (Circuit Breaking)

这是管道机制最核心的设计之一。

- 如果某个管道（如 `ValidationPipe`）在 `transform` 方法中抛出了异常（如 `BadRequestException`）。
- **整个责任链立即终止**。
- 后续的管道**不会**被执行。
- 目标 Controller 方法**不会**被执行。
- 控制权直接移交给 **异常过滤器 (Exception Filter)**，由它给前端返回 400 错误。

这种设计确保了：**只有完全干净、合法的数据，才有资格触碰你的业务逻辑代码**。

## 3. 核心用法 / 方案设计 (Usage / Design)

### 3.1 全局启用 (main.ts)

推荐在入口文件开启全局管道

```typescript
app.useGlobalPipes(new ValidationPipe({
  whitelist: true, // 🛡️ 核心安全设置：自动剔除 DTO 中未定义的属性（防止恶意注入）
  transform: true, // 🔄 自动类型转换（如 URL 里的 id 字符串转数字）
}));
```

### 3.2 常用校验装饰器图谱

| 装饰器                   | 作用                                                                     | 示例                 |
| :----------------------- | :----------------------------------------------------------------------- | :------------------- |
| **基础类型**       |                                                                          |                      |
| `@IsString()`          | 必须是字符串                                                             | `username: string` |
| `@IsInt()`             | 必须是整数                                                               | `age: number`      |
| `@IsBoolean()`         | 必须是布尔值                                                             | `isAdmin: boolean` |
| **常用逻辑**       |                                                                          |                      |
| `@IsNotEmpty()`        | 不能为 null, undefined 或空字符串                                        | 必填项               |
| `@IsOptional()`        | **重要**：可选字段。如果字段不存在，跳过后续校验；如果存在，才校验 | `age?: number`     |
| **字符串规则**     |                                                                          |                      |
| `@IsEmail()`           | 必须符合邮箱格式                                                         | `email: string`    |
| `@Length(min, max)`    | 长度在范围内 (涵盖了 MinLength/MaxLength)                                | `@Length(6, 20)`   |
| `@Matches(regex)`      | 正则匹配                                                                 | 手机号验证           |
| **数值规则**       |                                                                          |                      |
| `@Min(val)` / `@Max` | 最小值/最大值                                                            | `@Min(18)`         |

### 3.3 校验顺序与错误信息

**Q: 装饰器的执行顺序有关系吗？**
A: **没有严格关系**。`class-validator` 会遍历属性上的所有装饰器。

- 如果有多个校验失败（例如既不是 String 长度又不对），它通常会返回**所有的错误信息**，而不是遇到第一个就停止。
- 返回的错误信息数组顺序是不确定的，前端不应依赖这个顺序。

**Q: 如何自定义错误消息？**
A: 每个装饰器都接受一个 `ValidationOptions` 对象作为最后一个参数。

```typescript
// 示例
@IsString({ message: '用户名必须是字符串' }) // 自定义消息
@Length(2, 10, { message: '用户名长度需在 2-10 之间' })
username: string;
```

## 4. 最佳实践 (Best Practices)

- ✅ **必开 whitelist**: `whitelist: true` 是后端防止“参数污染攻击”的第一道防线。
- ✅ **可选字段记得加 @IsOptional**: 否则如果你传了 `null` 或者不传，可能会被 `@IsString` 等规则拦截报错。
- ✅ **正则验证**: 对于手机号、身份证等特定格式，优先使用 `@Matches` 配合严格的正则。
- ✅ **DTO 分离**: CreateDto 和 UpdateDto 校验规则往往不同（Update 时通常所有字段都是可选的），配合 `PartialType` 可以完美解决。

## 5. 行动导向 (Quick Start)

### Step 1: 安装依赖

```bash
npm install class-validator class-transformer
```

### Step 2: 全局注册管道 (main.ts)

启用全局 `ValidationPipe` 并开启白名单模式（Whitelist），这能自动过滤掉 DTO 中未定义的字段，防止参数污染。

```typescript
// src/main.ts
app.useGlobalPipes(new ValidationPipe({
  whitelist: true, // 自动剔除 DTO 中未定义的属性 (防止恶意字段注入)
  transform: true, // 自动转换参数类型 (如将 ID 字符串转为数字)
}));
```

### Step 3: 定义 DTO (create-user.dto.ts)

使用 `class-validator` 装饰器定义校验规则。

```typescript
// src/user/dto/create-user.dto.ts
import { IsEmail, IsString, IsInt, Min, IsOptional, Length } from 'class-validator';

export class CreateUserDto {
  @IsEmail({}, { message: '邮箱格式错误' })
  email: string;

  @IsString()
  @Length(6, 20)
  password: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  age?: number;
}
```

### Step 4: 在 Controller 中使用

只要参数类型被指定为 DTO 类，ValidationPipe 就会自动拦截并校验。

```typescript
@Post()
create(@Body() dto: CreateUserDto) {
  // 如果代码能执行到这里，说明 dto 一定是经过校验且安全的
  return this.userService.create(dto);
}
```
