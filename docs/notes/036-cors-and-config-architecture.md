# 036. CORS 跨域配置与配置架构重构

## 1. 核心问题与概念

### 解决什么问题

1. **CORS 跨域限制**：浏览器的同源策略阻止前端应用访问不同域的后端 API，需要服务端显式允许。
2. **配置膨胀**：随着项目增长，`.env` 文件从十几行膨胀到 60+ 行，维护困难。
3. **配置分类混乱**：敏感信息（密钥）、环境差异配置（端口）、业务默认值（过期时间）混杂在一起。

### 核心概念

| 概念                        | 说明                                                                    |
| --------------------------- | ----------------------------------------------------------------------- |
| **CORS**              | Cross-Origin Resource Sharing，浏览器安全机制，通过 HTTP 头控制跨域访问 |
| **Preflight Request** | 浏览器对复杂请求先发送 OPTIONS 预检请求，询问服务器是否允许             |
| **Origin 白名单**     | 服务端维护的允许访问的域名列表，生产环境必须严格配置                    |
| **registerAs**        | NestJS ConfigModule 提供的命名空间配置函数，实现配置分层                |

---

## 2. 核心用法 / 方案设计 (Usage / Design)

### 场景 A: CORS 白名单配置

```typescript
// src/common/configs/config/cors.config.ts
export default registerAs('cors', () => {
  // 解析白名单域名列表
  const originsString = process.env.CORS_ORIGINS || '';
  const origins = originsString
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  return {
    // 白名单域名列表
    origins,
  
    // 允许的 HTTP 方法
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  
    // 允许的请求头
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  
    // 允许浏览器读取的响应头
    exposedHeaders: ['Content-Disposition'],
  
    // 是否允许携带凭证 (Cookie, Authorization Header)
    credentials: true,
  
    // 预检请求缓存时间 (秒) - 24 小时
    maxAge: 86400,
  };
});
```

### 场景 B: main.ts 中启用 CORS

```typescript
// src/main.ts
  const corsConfig = configService.get('cors');
  app.enableCors({
    // 白名单校验函数：只允许配置中的域名访问
    origin: (origin, callback) => {
      // 允许无 origin 的请求 (服务器间调用、curl、Postman 等)
      if (!origin) {
        return callback(null, true);
      }
      // 检查是否在白名单中
      if (corsConfig.origins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    // 允许的 HTTP 方法
    methods: corsConfig.methods,
    // 允许的请求头 (Authorization 用于 JWT, X-Requested-With 用于 AJAX 识别)
    allowedHeaders: corsConfig.allowedHeaders,
    // 允许浏览器读取的响应头
    exposedHeaders: corsConfig.exposedHeaders,
    // 允许携带凭证 (Cookie, Authorization Header)
    credentials: corsConfig.credentials,
    // 预检请求 (OPTIONS) 缓存时间：24 小时，减少 preflight 请求次数
    maxAge: corsConfig.maxAge,
  });
```

### 场景 C: 配置分层架构

```
src/common/configs/
├── app-config.module.ts      # 配置模块入口
├── setup-swagger.ts          # Swagger 配置
└── config/                   # 领域配置文件
    ├── index.ts              # 统一导出
    ├── app.config.ts         # 应用基础 (端口、环境)
    ├── database.config.ts    # 数据库
    ├── redis.config.ts       # Redis
    ├── jwt.config.ts         # JWT 双 Token
    ├── storage.config.ts     # 文件存储
    ├── cors.config.ts        # CORS 跨域
    └── logger.config.ts      # 日志
```

---

## 3. 深度原理与机制 (Under the Hood)

### CORS 请求流程

```
浏览器                          服务器
  |                               |
  |------ OPTIONS (Preflight) --->|  (复杂请求先发预检)
  |<----- Access-Control-* ------|  (服务器返回允许的头)
  |                               |
  |------ 实际请求 (GET/POST) --->|
  |<----- 响应 + CORS 头 --------|
```

### Swagger UI 与 CORS 的关系

Swagger UI 运行在 `http://localhost:3000`（与后端同域），但它发起 API 请求时会带上 `Origin` 请求头。如果后端 CORS 白名单未包含此域名，请求会被拒绝。

**解决方案**：在 `CORS_ORIGINS` 中包含 Swagger 运行的域名。

```bash
# .env
CORS_ORIGINS=http://localhost:5173,http://localhost:3000
```

### 配置分类原则

| 类型                 | 特征           | 存放位置        | 示例                        |
| -------------------- | -------------- | --------------- | --------------------------- |
| **敏感信息**   | 不可泄露       | `.env` (必须) | DB_PASS, JWT_SECRET         |
| **环境差异**   | 不同环境值不同 | `.env` (必须) | DB_HOST, REDIS_HOST         |
| **业务默认值** | 有合理默认值   | 配置文件代码    | JWT 过期时间、CORS 方法列表 |
| **固定常量**   | 永不变化       | 代码中硬编码    | 支持的文件类型              |

---

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

### ✅ 推荐做法

1. **白名单严格配置**：生产环境必须显式配置 `CORS_ORIGINS`，禁止使用 `origin: true`。
2. **配置分层**：敏感信息放 `.env`，业务默认值写在配置文件代码中。
3. **预检缓存**：设置 `maxAge: 86400` (24h)，减少 OPTIONS 请求开销。
4. **提交 `.env.example`**：Git 仓库只提交示例文件，包含变量名和注释，不含真实值。

### ❌ 避免做法

1. **生产环境使用 `origin: true`**：等于允许任意域名访问，存在 CSRF 风险。
2. **在 `.env` 中写死业务默认值**：导致文件膨胀，且默认值分散难维护。
3. **部署时手动修改 `.env` 再改回去**：易出错且不可追溯。

---

## 5. .env 生产级管理方案

### 核心原则

> **代码与配置分离，配置与环境绑定。**
>
> 同一份代码/镜像部署到不同环境，通过注入不同配置实现差异化。

### 方案对比

| 方案                       | 适用场景   | 做法                                                  |
| -------------------------- | ---------- | ----------------------------------------------------- |
| **多 `.env` 文件** | 小型项目   | `.env.development`、`.env.production`，启动时指定 |
| **环境变量注入**     | 容器化部署 | `docker run -e` 或 K8s ConfigMap/Secret             |
| **Secret Manager**   | 企业级     | AWS Secrets Manager / HashiCorp Vault                 |

### 推荐实践

```
项目根目录/
├── .env              # 本地开发用，已被 .gitignore 忽略
├── .env.example      # Git 提交，包含变量名和注释
└── docker-compose.yml # 生产环境通过 environment 或 env_file 注入
```

**.env.example 示例**：

```bash
# === 应用基础 ===
APP_ENV=development
APP_PORT=3000

# === 数据库 (敏感) ===
DB_HOST=localhost
DB_PORT=5432
DB_NAME=your_database
DB_USER=your_user
DB_PASS=your_password

# === JWT 密钥 (敏感) ===
JWT_ACCESS_SECRET=change-me-in-production
JWT_REFRESH_SECRET=change-me-in-production

# === CORS 白名单 ===
# 开发环境包含 Swagger 地址，生产环境配置真实前端域名
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
```

---

## 6. 行动导向 (Action Guide)

### Step 1: 创建配置文件目录结构

**这一步在干什么**：将原本集中在 `app-config.module.ts` 的配置逻辑拆分到独立文件，实现关注点分离。

```bash
mkdir src/common/configs/config
```

### Step 2: 创建领域配置文件

**这一步在干什么**：使用 `registerAs` 为每个领域创建命名空间配置，支持类型推导和结构化访问。

```typescript
// src/common/configs/config/cors.config.ts
import { registerAs } from '@nestjs/config';

export default registerAs('cors', () => {
  const originsString = process.env.CORS_ORIGINS || '';
  const origins = originsString.split(',').map(o => o.trim()).filter(Boolean);

  return {
    origins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['Content-Disposition'],
    credentials: true,
    maxAge: 86400,
  };
});
```

### Step 3: 创建统一导出入口

**这一步在干什么**：聚合所有配置文件，便于 `ConfigModule.forRoot({ load: [...] })` 一次性加载。

```typescript
// src/common/configs/config/index.ts
import appConfig from './app.config';
import databaseConfig from './database.config';
import redisConfig from './redis.config';
import jwtConfig from './jwt.config';
import storageConfig from './storage.config';
import corsConfig from './cors.config';
import loggerConfig from './logger.config';

export const configurations = [
  appConfig,
  databaseConfig,
  redisConfig,
  jwtConfig,
  storageConfig,
  corsConfig,
  loggerConfig,
];
```

### Step 4: 重构 AppConfigModule

**这一步在干什么**：简化配置模块，只保留 Joi 校验敏感信息，业务默认值由各配置文件自行管理。

```typescript
// src/common/configs/app-config.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as Joi from 'joi';
import { configurations } from './config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: configurations,
      // 只校验必须从环境变量提供的敏感信息
      validationSchema: Joi.object({
        APP_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
        DB_HOST: Joi.string().required(),
        DB_NAME: Joi.string().required(),
        JWT_ACCESS_SECRET: Joi.string().required(),
        JWT_REFRESH_SECRET: Joi.string().required(),
        // ... 其他敏感配置
      }),
    }),
  ],
  exports: [ConfigModule],
})
export class AppConfigModule {}
```

### Step 5: 在 main.ts 中启用 CORS

**这一步在干什么**：从配置服务读取 CORS 配置，启用白名单校验机制。

```typescript
// src/main.ts
const corsConfig = configService.get('cors');
app.enableCors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (corsConfig.origins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    }
  },
  methods: corsConfig.methods,
  allowedHeaders: corsConfig.allowedHeaders,
  exposedHeaders: corsConfig.exposedHeaders,
  credentials: corsConfig.credentials,
  maxAge: corsConfig.maxAge,
});
```

### Step 6: 配置 .env 白名单

**这一步在干什么**：为 Swagger UI 和前端应用配置允许的域名。

```bash
# .env
CORS_ORIGINS=http://localhost:3000,http://localhost:5173
```
