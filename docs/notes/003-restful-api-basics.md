# 003. RESTful API 风格指南 (RESTful API Basics)

## 1. 背景与需求 (Context & Requirements)
- **场景**: 后端开发中，API 接口设计风格多样，如果没有统一规范，容易导致接口混乱、难以维护、前后端协作成本高。
- **目标**: 
  1. 理解 REST (Representational State Transfer) 的核心理念。
  2. 掌握标准的 URL 设计和 HTTP 方法使用规范。
  3. 区分推荐与反模式的设计，编写优雅的接口。

## 2. 核心用法 / 方案设计 (Usage / Design)

### 2.1 核心理念 (Origins & Core)
REST 不是一种协议，而是一种**架构风格**。它强调：
1. **资源 (Resources)**: 网络上的所有事物都被抽象为资源（如用户、文章、订单）。
2. **表现层 (Representation)**: 资源具体的呈现形式（JSON, XML 等），通过 HTTP Header (`Accept`, `Content-Type`) 指定。
3. **状态转移 (State Transfer)**: 客户端通过 HTTP 动词（GET, POST 等）来操作资源，驱动服务端状态的流转。

### 2.2 最佳实践三要素 (Best Practices)
| 要素 | 说明 | 示例 |
| :--- | :--- | :--- |
| **URL (资源)** | 名词、复数、层级化 | `/users`, `/orders/123` |
| **HTTP Method (动作)** | 利用标准动词表达操作 | `GET` (查), `POST` (增), `DELETE` (删) |
| **Status Code (结果)** | 利用标准状态码表达结果 | `200 OK`, `201 Created`, `404 Not Found` |

## 3. 最佳实践 (Design Patterns)

### ✅ 3.1 资源路径设计 (URL Patterns)

**原则 A: 使用名词，且推荐复数**
- ❌ `GET /getUsers` (不要把动词放在 URL 里，动词由 HTTP Method 承担)
- ❌ `POST /createUser` 
- ✅ `GET /users` (获取用户列表)
- ✅ `POST /users` (创建一个用户)
- ❌ `/user/1` (单数通常不推荐，保持一致性用复数)
- ✅ `/users/1` (获取 ID 为 1 的用户)

**原则 B: 资源层级与过滤**
- **层级关系**:
  - ✅ `/users/1/orders` (获取用户 1 的所有订单)
- **复杂查询 (使用 Query Parameters)**:
  - ❌ `/authors/12/categories/2` (层级过深，且关系不明确)
  - ✅ `/authors/12?categories=2` (推荐：资源是作者，分类是筛选条件)

### ✅ 3.2 HTTP 动词映射

| 动作 | HTTP Method | 含义 | 幂等性 (Idempotent) |
| :--- | :--- | :--- | :--- |
| **查** | `GET` | 获取资源 | ✅ (多次请求结果一致) |
| **增** | `POST` | 新建资源 | ❌ (多次请求创建多个) |
| **改 (全量)** | `PUT` | 替换整个资源 | ✅ |
| **改 (部分)** | `PATCH` | 更新资源部分字段 | ❌ (通常视为非幂等，视实现而定) |
| **删** | `DELETE` | 删除资源 | ✅ |

### ✅ 3.3 元数据传递 (Headers)

不应将格式控制放在 URL 中，而应使用 HTTP Headers：
- ❌ `GET /users?format=xml`
- ✅ Header: `Accept: application/json` 或 `application/xml` (客户端告诉服务端想要什么)
- ✅ Header: `Content-Type: application/json` (服务端/客户端告诉对方发的是什么)

### 3.4 深入理解：幂等性 (Idempotence)

**定义**:
如果一个接口被**多次调用**（例如点击多次、网络重试），对服务器状态产生的**影响**与**调用一次**是完全相同的，那么这个接口就是**幂等**的。

**为什么重要？**
- **安全性**: 在网络不稳定的情况下（比如用户点击付款没反应，又点了一次），幂等性保证了不会重复扣款或创建重复数据。
- **重试机制**: 如果接口是幂等的，客户端在超时未响应时可以放心地自动重试。

**Method 对比**:
- **GET (幂等)**: 无论查多少次，数据库里的数据都不会变。
- **PUT (幂等)**: 
  - 逻辑: "把 ID=1 的名字改为 Alice"。
  - 结果: 无论请求一次还是十次，最终 ID=1 的名字都是 Alice。
- **DELETE (幂等)**:
  - 逻辑: "删除 ID=1 的数据"。
  - 结果: 第一次删除成功；第二次删除时数据已不存在（虽然返回 404，但服务器上数据已清除的状态没变）。
- **POST (非幂等)**:
  - 逻辑: "创建一个新用户"。
  - 结果: 请求 3 次，数据库就会新增 3 条记录（除非有唯一索引约束）。

## 4. 行动导向 (Action Guide) 

### ✅ Task 1: 审查并重构当前接口
如果你正在设计 User 模块，请对照以下清单自查：

1. **列表接口**:
   - 之前: `@Get('get_all')`
   - 修正: `@Get()` (配合 Controller 的 `@Controller('users')` 路径变为 `GET /users`)

2. **详情接口**:
   - 之前: `@Get('detail/:id')`
   - 修正: `@Get(':id')` (路径变为 `GET /users/1`)

3. **创建接口**:
   - 之前: `@Post('add')`
   - 修正: `@Post()` (路径变为 `POST /users`)

### ✅ Task 2: 复杂层级判断
- 问自己：“我是要查询子资源，还是要筛选？”
- **子资源**: `GET /classes/1/students` (一班的所有学生)
- **筛选**: `GET /students?classId=1` (所有学生中，是一班的那些) -> **通常这种更灵活**

