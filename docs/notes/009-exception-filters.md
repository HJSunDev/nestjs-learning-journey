# 009. 统一异常处理与 Filter 深度解析

## 1. 核心问题与概念 (The "Why")

- **解决什么问题**: 
  - **响应格式不统一**: 框架默认抛出的 JSON 结构（`{statusCode, message}`）过于简单，缺乏请求路径、时间戳等调试信息。
  - **逻辑重复**: 如果在每个 Controller 里都写 `try-catch` 来捕获错误并手动 format 响应，代码会极其冗余。
  
- **核心概念**:
  - **Exception Filter (异常过滤器)**: NestJS 的 AOP（切面编程）组件之一。它像一张捕鱼网，挂在应用的最外层。当业务代码（Service/Controller）抛出**任何**未捕获的异常时，这张网会接住它，并负责生成最终发给前端的 HTTP 响应。

---

## 2. 深度原理与机制 (Under the Hood)

您在代码中看到的每个 API，背后都有特定的设计意图。让我们逐行拆解 `HttpExceptionFilter`。

### 2.1 过滤器核心组件解析

```typescript
@Catch(HttpException) // 👈 1. 捕获声明
export class HttpExceptionFilter implements ExceptionFilter {
  
  // 👈 2. 核心处理函数
  catch(exception: HttpException, host: ArgumentsHost) {
    
    // 👈 3. 上下文切换
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    
    // ... 具体的响应构建逻辑
    response.status(404).json({ ... });
  }
}
```

#### 🛠️ 关键 API 详解

1.  **`@Catch(HttpException)`**:
    -   **作用**: 告诉 NestJS 这个过滤器**只关心** `HttpException` 及其子类（如 `NotFoundException`, `BadRequestException`）。
    -   **原理**: 就像 `try-catch` 语句中的 `catch(e)`，这里是声明式的。如果抛出的是系统级 Error（如 `TypeError`），这个过滤器会直接忽略（除非你把 `@Catch()` 参数留空，那就捕获所有）。

2.  **`ArgumentsHost` (host)**:
    -   **为什么不用 `req, res`?**: 因为 NestJS 是跨平台的，它不仅能写 HTTP API，还能写 WebSocket 或微服务 (gRPC)。
    -   **`host` 是什么**: 它是一个**通用的上下文包装器**。不管底层是 Express (HTTP) 还是 socket.io (WS)，`host` 里都存着当前的请求参数。
    -   **`host.switchToHttp()`**: 这是一个辅助方法，明确告诉 Nest："我知道我现在处理的是 HTTP 请求，请把上下文切到 HTTP 模式，让我能拿到 `Request` 和 `Response` 对象"。

3.  **`ctx.getResponse<Response>()`**:
    -   **作用**: 获取底层的 Express 响应对象 (`res`)。
    -   **`response.status(404).json(...)`**: 这是标准的 **Express.js API**。
        -   `.status(n)`: 设置 HTTP 状态码。
        -   `.json(obj)`: 将对象序列化为 JSON 字符串并发送给客户端，同时结束请求。

### 2.2 异常对象的传递机制 (`exception.getResponse`)

当我们在 Service 中抛出异常时：

```typescript
throw new NotFoundException('User with ID 999 not found');
// 或者传递对象
throw new NotFoundException({ key: 'USER_NOT_FOUND', msg: '...' });
```

在 Filter 中捕获到的 `exception` 对象：

-   `exception.getStatus()` -> 返回 **404** (由异常类决定)。
-   `exception.getResponse()` -> 返回构造函数里的**第一个参数**。
    -   如果传的是字符串 `'User not found'`，这里拿到的就是字符串。
    -   如果传的是对象，这里拿到的就是那个对象。
    -   *默认行为*: 如果只传字符串，Nest 会自动把它包装成 `{ statusCode: 404, message: '...' }`。

---

## 3. 实战代码演示 (Code in Action)

**场景**: 我们希望无论系统发生什么 HTTP 错误，前端收到的 JSON 结构永远包含 `timestamp` 和 `path`。

### 步骤 1: 编写 Filter

```typescript
// src/common/filters/http-exception.filter.ts
import { ExceptionFilter, Catch, ArgumentsHost, HttpException } from '@nestjs/common';
import { Request, Response } from 'express';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>(); // 获取 Express res 对象
    const request = ctx.getRequest<Request>();    // 获取 Express req 对象
    
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    // 统一封装响应体
    const errorBody = {
      statusCode: status,
      timestamp: new Date().toISOString(), // 👈 补充时间戳
      path: request.url,                   // 👈 补充请求路径
      // 兼容处理：如果 exceptionResponse 是字符串就包一层，是对象就展开
      details: typeof exceptionResponse === 'string' 
        ? { message: exceptionResponse } 
        : exceptionResponse
    };

    // 发送响应
    response.status(status).json(errorBody);
  }
}
```

### 步骤 2: 触发异常 (Service 层)

```typescript
// src/user/user.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';

@Injectable()
export class UserService {
  findOne(id: number) {
    if (id === 999) {
      // 🚀 直接抛出！不需要 return，也不需要管 response
      throw new NotFoundException(`User #${id} not found`);
    }
    return `User #${id}`;
  }
}
```

### 步骤 3: 客户端收到的结果

```json
{
  "statusCode": 404,
  "timestamp": "2023-10-27T10:30:00.000Z",
  "path": "/user/999",
  "details": {
    "message": "User #999 not found",
    "error": "Not Found",
    "statusCode": 404
  }
}
```

---

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

-   ✅ **全局注册**: 既然是“统一”异常处理，通常在 `main.ts` 中使用 `app.useGlobalFilters(new HttpExceptionFilter())` 进行全局注册。
-   ✅ **区分环境**: 可以在 Filter 里判断 `process.env.NODE_ENV`，如果是开发环境，把 `exception.stack` (堆栈信息) 也打印到 JSON 里方便调试；生产环境则隐藏。
-   ❌ **捕获范围过大**: 如果把 `@Catch()` 留空，它会捕获所有错误（包括代码写错导致的 `RuntimeError`）。处理不当可能导致死循环或掩盖关键 Bug。通常建议只捕获 `HttpException`，或者分开写两个 Filter（一个处理 HTTP 错误，一个处理系统级崩溃）。
-   ❌ **忘记 `switchToHttp`**: 在使用 WebSocket 或 Microservices 时，直接用 `ctx.getResponse()` 可能会报错，因为上下文类型不同。

---

## 5. 行动导向 (Action Guide)

**(类型 C: 方案实现) -> 搭建异常治理体系**

-   [Step 1] **创建文件**: 在 `src/common/filters/` 目录下创建 `http-exception.filter.ts`。
    ```bash
    mkdir -p src/common/filters
    touch src/common/filters/http-exception.filter.ts
    ```
-   [Step 2] **编写代码**: 将上文“实战代码演示”中的 `HttpExceptionFilter` 类代码完整复制到该文件中。
-   [Step 3] **全局注册**: 打开 `src/main.ts`，引入 Filter 并注册。
    ```typescript
    import { HttpExceptionFilter } from './common/filters/http-exception.filter';
    // ...
    app.useGlobalFilters(new HttpExceptionFilter());
    ```
-   [Step 4] **业务改造**: 检查你的 Service 层（如 `user.service.ts`），将所有返回错误对象的逻辑（如 `return { error: 'Not Found' }`）替换为抛出异常。
    ```typescript
    // ✅ 推荐
    throw new NotFoundException('资源未找到');
    ```
-   [Step 5] **验证**: 启动服务 (`npm run start:dev`)，使用浏览器或 Postman 访问一个故意出错的接口（如 `/user/99999`），确认返回的 JSON 包含 `timestamp` 和 `path` 字段。

