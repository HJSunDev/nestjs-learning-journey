# 028. 基于 Helmet 的 HTTP 安全加固 (HTTP Security Hardening)

## 1. 核心问题与概念

### HTTP 安全威胁概览

Web 应用暴露在公网中，面临多种常见的攻击威胁：

1. **跨站脚本攻击 (XSS)**: 攻击者通过注入恶意代码 (Script)，使用户暴露于其控制下的危险之中（如窃取 Cookie）。
2. **点击劫持 (Clickjacking)**: 攻击者利用透明 iframe 覆盖在网页上，诱骗用户点击实际上不想点击的按钮（如“确认转账”）。
3. **跨站请求伪造 (CSRF)**: 攻击者利用已认证用户的身份，强制他们执行意外的、未经授权的操作（如静默发帖）。
4. **SQL 注入攻击**: 提交恶意 SQL 查询，从而访问、修改或删除数据库数据（主要靠 ORM 防止）。
5. **HTTP 劫持**: 攻击者截取网络通信，在不被察觉的情况下更改或监视流量（主要靠 HTTPS 防止）。
6. **DoS 攻击**: 发送大量无效请求耗尽服务器资源。
7. **网络钓鱼攻击**: 伪装成可信实体欺骗用户。

### Helmet 解决了什么？

**Helmet 是一个中间件集合，它主要通过设置 HTTP 响应头来增强安全性。**

| 威胁类型            | Helmet 是否解决        | 原理说明                                                                                                                             |
| :------------------ | :--------------------- | :----------------------------------------------------------------------------------------------------------------------------------- |
| **XSS**       | ✅**核心解决**   | 通过 `Content-Security-Policy` (CSP) 限制脚本来源，通过 `X-XSS-Protection` 开启浏览器防护。                                      |
| **点击劫持**  | ✅**核心解决**   | 通过 `X-Frame-Options` 禁止页面被 iframe 嵌入，或限制嵌入来源。                                                                    |
| **HTTP 劫持** | ⚠️**部分辅助** | 通过 `Strict-Transport-Security` (HSTS) 强制浏览器使用 HTTPS 连接，防止降级攻击。                                                  |
| **CSRF**      | ❌**不直接解决** | **注意**: Helmet 本身不生成 CSRF Token。防 CSRF 需要专门的中间件 (如 `csurf`)。但 CSP 可以限制 Form 提交目标，起到辅助作用。 |
| SQL 注入            | ❌ 不解决              | 这是代码逻辑层的问题，需通过 ORM 或参数化查询解决。                                                                                  |
| DoS / 钓鱼          | ❌ 不解决              | 需要基础设施层面的防护（如 WAF、Rate Limiting）。                                                                                    |

**结论**: 这一章节的 Helmet 库，主要精准打击的是 **XSS** 和 **点击劫持**，并辅助加强 **HTTPS (HTTP 劫持)** 的安全性。

## 2. 核心用法 / 方案设计 (Usage / Design)

### 场景: 基础安全加固与 Swagger 兼容

在 NestJS 中集成 Helmet 非常简单，但直接使用默认配置会拦截 Swagger UI 的运行（因为 Swagger 使用了内联脚本和样式）。因此，我们的核心设计在于**定制 CSP (内容安全策略)**。

#### ❌ 错误做法：直接使用默认配置

```typescript
// 这会导致 Swagger UI 页面空白，控制台报错 CSP 拦截
app.use(helmet()); 
```

#### ✅ 正确做法：定制 CSP 策略

我们需要为 Swagger UI 开放特定的权限：

- `'unsafe-inline'`: 允许内联脚本和样式。
- `'unsafe-eval'`: 允许部分动态脚本执行（视 Swagger 版本而定）。
- `data:`: 允许 Base64 图片加载。

## 3. 深度原理与机制 (Under the Hood)

- **Helmet 的工作方式**: Helmet 实际上是 15 个小型中间件的集合。

  - `contentSecurityPolicy`: 设置 `Content-Security-Policy` 头，防止 XSS。
  - `crossOriginEmbedderPolicy`: 控制资源嵌入策略。
  - `xFrameOptions`: 设置 `X-Frame-Options: SAMEORIGIN`，防止点击劫持。
  - `strictTransportSecurity`: 设置 `Strict-Transport-Security`，强制客户端使用 HTTPS。
  - `xContentTypeOptions`: 防止浏览器 MIME 类型嗅探。
- **CSP (Content Security Policy) 机制**: 它是浏览器的一层白名单机制。默认情况下，Helmet 的 CSP 禁止任何非同源的资源加载，也禁止 `<script>...</script>` 这种内联写法，因为这正是 XSS 攻击的常用手段。

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

- ✅ **最佳实践**:
  - 在 `main.ts` 最早期注册 Helmet，确保所有响应都包含安全头。
  - 生产环境如果可能，尽量移除 `'unsafe-inline'`，但这通常需要配合构建工具生成 Nonce (随机数)，实施成本较高。对于 Swagger 这种开发工具，例外处理是可接受的。
- ❌ **避免做法**:
  - 仅仅因为报错就完全禁用 CSP (`contentSecurityPolicy: false`)。这相当于关闭了最强大的防线。
  - 误以为 Helmet 能防 SQL 注入或 CSRF，从而忽略了其他层面的防护。

## 5. 行动导向 (Action Guide)

### Step 1: 安装依赖

**这一步在干什么**: 引入 `helmet` 库。

```bash
npm install helmet
```

### Step 2: 配置全局中间件

**这一步在干什么**: 在应用启动时注册 Helmet，并配置 CSP 以兼容 Swagger UI。

**修改 `src/main.ts`**:

```typescript
import helmet from 'helmet';
// ... 其他 import

async function bootstrap() {

  // 1. 创建应用实例，开启 bufferLogs 以便完全接管启动日志
  // 使用 NestExpressApplication 泛型，来支持 Express 类型HTTP 适配器特有的方法代码提示 以及 类型推导
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  
  // ... 日志配置等

  // 3. 配置 HTTP 安全头 (Helmet)
  // 生产环境建议开启 contentSecurityPolicy，但需兼容 Swagger UI 的 inline script/style
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // Swagger UI 依赖
          styleSrc: ["'self'", "'unsafe-inline'"], // Swagger UI 依赖
          imgSrc: ["'self'", 'data:', 'validator.swagger.io'], // Swagger Validator 图标
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // ... 其他配置
}
```
