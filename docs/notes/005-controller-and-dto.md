# 005. Controller 与 DTO 详解

## 1. 背景与需求 (Context & Requirements)

- **场景**: 任何 Web 框架都需要一个组件来接收用户的 HTTP 请求并做出响应。
- **历史渊源**: **MVC 架构 (Model-View-Controller)**。
  - 在传统的 MVC（如 SpringMVC, Rails）中，Controller 负责接收请求，调用 Model 处理数据，最后选择一个 View（HTML模板）返回给用户。
  - 在现代 **RESTful API** 架构中，View 层通常被剥离给前端（React/Vue），Controller 专注于**接收请求**和**返回 JSON 数据**。
- **核心目标**: 理解 NestJS 中控制器的职责边界，以及如何通过 DTO 规范数据交互。

## 2. 核心概念 (Core Concepts)

### 2.1 控制器 (Controller)

**职责**: 

- **只做三件事**:
  1. **路由分发**: 决定哪个 URL 由哪个函数处理。
  2. **解析参数**: 从请求中提取 Body, Query, Param。
  3. **调用服务**: 将具体的业务逻辑委托给 Service 层（不要在 Controller 写业务逻辑！）。

### 2.2 DTO (Data Transfer Object)

**定义**: 数据传输对象。

- **通俗理解**: 前后端交互的“快递单规范”。
- **为什么需要它**:
  - **安全性**: 过滤掉不想接收的字段（如用户恶意传 `isAdmin: true`）。
  - **解耦**: 数据库存的是 `first_name`, `last_name`，但前端可能只发一个 `fullName`。DTO 负责中间的形态定义。
  - **文档**: 配合 Swagger，自动生成清晰的 API 参数文档。

## 3. 核心用法 / 方案设计 (Usage / Design)

### 3.1 控制器装饰器图谱

```typescript
@Controller('users') // 1. 主路由 (类级别)
export class UserController {
  
  // 2. HTTP 方法装饰器
  @Post()          // POST /users
  @Get(':id')      // GET /users/123
  @Put('profile')  // PUT /users/profile (子路由)

  // 3. 参数提取装饰器 (方法参数级别)
  update(
    @Param('id') id: string,      // 路径参数 /users/:id
    @Body() dto: UpdateUserDto,   // 请求体 Body
    @Query('page') page: number,  // 查询参数 ?page=1
    @Headers('token') token: string // 请求头
  ) { ... }
}
```

### 3.2 DTO 的最佳实践结构

```typescript
// create-user.dto.ts
import { IsEmail, IsString } from 'class-validator'; 
import { ApiProperty } from '@nestjs/swagger';

export class CreateUserDto {
  @ApiProperty({ description: '邮箱' }) // 给文档看
  @IsEmail()                            // 给验证管道看
  email: string;

  @ApiProperty({ description: '年龄', required: false })
  age?: number;
}
```

## 4. 最佳实践 (Best Practices)

- ✅ **保持 Controller 瘦身**: Controller 应该仅仅是路由和参数的搬运工，所有 if/else 业务逻辑都丢给 Service。
- ✅ **DTO 必须是类 (Class)**: 虽然 TypeScript 接口 (Interface) 也能定义类型，但在 NestJS 中，**必须用 Class 定义 DTO**。
  - *原因*: Interface 在编译成 JavaScript 后会消失，NestJS 运行时无法获取元数据（用于自动验证和 Swagger 生成）。Class 会保留。
- ✅ **明确返回类型**: 虽然 TS 能推断，但显式声明 `Promise<User>` 能让代码更易读。

## 5. 行动导向 (Implementation)

### 常见任务清单

**任务 A: 创建一个新的子路由**
目标：添加 `GET /users/active` 获取活跃用户。

```typescript
@Get('active') // 注意：静态路径 'active' 必须放在动态路径 ':id' 之前！
findActiveUsers() {
  return this.userService.findActive();
}
```

**任务 B: 处理复杂参数**
目标：接收分页和筛选。

```typescript
@Get()
findAll(
  @Query('page') page: number = 1, 
  @Query('limit') limit: number = 10
) {
  // 注意：Query 参数默认通过网络传输都是 String，可能需要转换
  return this.userService.findAll(+page, +limit);
}
```
