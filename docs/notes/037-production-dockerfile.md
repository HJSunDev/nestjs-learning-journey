# 037. 生产级 Docker 构建 (Production Dockerfile)

## 1. 核心问题与概念

### 解决什么问题

在生产环境中部署 NestJS 应用时，直接使用 `npm run start:prod` 存在以下问题：

1. **环境一致性**：开发机、测试环境、生产环境的 Node.js 版本、系统依赖可能不一致，导致"在我机器上能跑"的问题
2. **部署复杂度**：需要手动安装 Node.js、配置 PM2、处理进程管理
3. **镜像体积**：如果简单地把整个项目打包，镜像可能达到 1GB+，拖慢部署速度
4. **安全风险**：生产镜像包含 devDependencies、源代码、敏感配置文件

### 核心概念与依赖

| 概念                        | 角色            | 说明                                                                       |
| --------------------------- | --------------- | -------------------------------------------------------------------------- |
| **Multi-stage Build** | Docker 构建策略 | 使用多个 `FROM` 指令创建多个构建阶段，最终镜像只保留必需文件             |
| **Alpine 镜像**       | 基础操作系统    | 基于 musl libc 的精简 Linux 发行版，体积约 5MB（对比 Debian 的 ~120MB）    |
| **npm ci**            | 包管理命令      | 根据 `package-lock.json` 进行确定性安装，比 `npm install` 更快且可重现 |
| **HEALTHCHECK**       | 容器健康检查    | Docker 内置指令，定期检查容器内应用是否正常运行                            |

### 架构层级关系

```
┌─────────────────────────────────────────────────────────────┐
│                     docker-compose.yml                       │
│  (编排层 - 定义服务间关系、网络、环境变量)                      │
├─────────────────────────────────────────────────────────────┤
│                        Dockerfile                            │
│  (构建层 - 定义如何将源码构建为可运行镜像)                      │
├─────────────────────────────────────────────────────────────┤
│                      .dockerignore                           │
│  (过滤层 - 排除不需要进入构建上下文的文件)                      │
└─────────────────────────────────────────────────────────────┘
```

## 2. 核心用法 / 方案设计 (Usage / Design)

### 场景 A: 本地开发 (Local Development)

本地开发采用 **Node 本地运行 + 容器化数据库** 的模式：

```bash
# 启动基础设施 + 可视化工具 (Postgres, Redis, pgAdmin, Redis Insight)
npm run docker:dev

# 本地运行 NestJS (热重载)
npm run dev
```

**优势**：

- 代码修改即时生效，无需重新构建镜像
- IDE 调试、断点调试正常工作
- 避免 Windows/macOS 上 Docker Volume 的性能问题
- `docker:dev` 自动启动数据库可视化工具

### 场景 B: 生产部署 (Production Deployment)

生产环境使用完整容器化方案：

```bash
# 构建并启动生产服务 (app + Postgres + Redis)
npm run docker:prod

# 仅重新构建应用（代码更新时）
docker compose build app && npm run docker:prod
```

### 场景 C: 镜像分发 (Image Distribution)

构建镜像并推送到镜像仓库：

```bash
# 构建镜像并打标签
docker build -t your-registry/nest-app:v1.0.0 .

# 推送到镜像仓库
docker push your-registry/nest-app:v1.0.0
```

## 3. 深度原理与机制 (Under the Hood)

### 多阶段构建工作流

```
┌─────────────────────────────────────────────────────────────┐
│                  Stage 1: builder                            │
├─────────────────────────────────────────────────────────────┤
│  FROM node:22-alpine                                         │
│       ↓                                                      │
│  COPY package*.json → npm ci (全部依赖)                       │
│       ↓                                                      │
│  COPY . → npm run build                                      │
│       ↓                                                      │
│  产出: /app/dist (编译后的 JavaScript)                        │
│  ⚠️ 此阶段镜像约 500MB+（包含 devDependencies）               │
└─────────────────────────────────────────────────────────────┘
                              ↓
                    仅复制 /app/dist
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                  Stage 2: production                         │
├─────────────────────────────────────────────────────────────┤
│  FROM node:22-alpine (全新干净镜像)                           │
│       ↓                                                      │
│  COPY package*.json → npm ci --omit=dev (仅生产依赖)          │
│       ↓                                                      │
│  COPY --from=builder /app/dist ./dist                        │
│       ↓                                                      │
│  产出: 最终镜像约 150-180MB                                   │
└─────────────────────────────────────────────────────────────┘
```

### Docker 层缓存策略

Dockerfile 中指令的顺序经过优化，以最大化利用 Docker 的层缓存：

```dockerfile
# 1. 先复制依赖清单（变化频率低）
COPY package*.json ./
RUN npm ci

# 2. 再复制源代码（变化频率高）
COPY . .
RUN npm run build
```

**原理**：Docker 逐层构建，只要某一层的输入（文件内容 + 指令）没有变化，就会复用缓存。将变化频率低的操作放在前面，可以在代码修改时跳过 `npm ci` 这个耗时步骤。

### 健康检查机制

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --spider http://localhost:3000/health/liveness || exit 1
```

| 参数                  | 含义                                   |
| --------------------- | -------------------------------------- |
| `--interval=30s`    | 每 30 秒检查一次                       |
| `--timeout=10s`     | 单次检查超时时间                       |
| `--start-period=5s` | 容器启动后的宽限期，期间检查失败不计入 |
| `--retries=3`       | 连续失败 3 次后标记为 unhealthy        |

使用 `/health/liveness` 而非 `/health` 的原因：

- `liveness` 端点仅检查进程存活，响应极快
- `/health` 端点会检查数据库和 Redis，若外部依赖故障会误判应用不健康

### 容器网络通信

在 docker-compose 网络中，服务间通过**服务名**作为主机名通信：

```yaml
# app 服务的环境变量
DB_HOST: postgres    # 不是 localhost，而是服务名
REDIS_HOST: redis    # Docker DNS 自动解析
```

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

### ✅ 推荐做法

1. **使用 Alpine 镜像**：体积小，安全漏洞更少
2. **使用 `npm ci` 而非 `npm install`**：确定性安装，构建可重现
3. **使用非 root 用户运行**：`USER node` 限制容器内权限
4. **环境变量注入敏感信息**：密钥不进入镜像，运行时通过 `-e` 或 `.env` 注入
5. **分离健康检查端点**：liveness 检查进程，readiness 检查依赖

### ❌ 避免做法

1. **不要在镜像中包含 `.env` 文件**：敏感信息泄露风险
2. **不要使用 `npm install`**：可能因 lock 文件不同导致依赖版本差异
3. **不要忽略 `.dockerignore`**：构建上下文过大会显著拖慢构建速度
4. **不要在生产镜像中包含 devDependencies**：增加体积和攻击面
5. **不要使用 `latest` 标签**：版本不可追溯，难以回滚

### 常见问题

**Q: 为什么用 `wget` 而不是 `curl` 做健康检查？**
A: Alpine 镜像默认不包含 `curl`，但 BusyBox 提供了 `wget`。

**Q: `depends_on` 的 `condition: service_healthy` 不生效？**
A: 被依赖的服务必须配置 `healthcheck`，否则 Docker 认为它永远不会 healthy。

## 5. 行动导向 (Action Guide)

### Step 1: 创建 .dockerignore

**这一步在干什么**：定义构建上下文的排除规则，避免将 node_modules、数据目录、敏感文件复制到 Docker 守护进程。

```bash
# 文件路径: .dockerignore
```

```gitignore
# ====================================
# Docker Build Context Ignore Rules
# ====================================
# 作用：排除不需要复制到 Docker 构建上下文的文件
# 好处：1) 减少构建上下文传输时间  2) 避免敏感信息泄露  3) 提高构建缓存命中率

# === 依赖与构建产物 ===
# 容器内会重新 npm ci，无需复制本地 node_modules
node_modules
# 构建产物由容器内生成
dist
build

# === 版本控制 ===
.git
.gitignore

# === 环境变量文件 ===
# 敏感信息不应打包进镜像，应通过运行时环境变量注入
.env
.env.*
!.env.example
!.env.production.example

# === 日志与运行时数据 ===
logs
*.log
npm-debug.log*
pids
*.pid

# === 数据库数据卷 ===
# 这些目录由 docker-compose volumes 管理，不应进入构建上下文
postgres-data
redis-data
mongo-data
pgadmin-data
redis-insight-data

# === 用户上传文件 ===
# 生产环境应使用 OSS/S3，本地上传目录不应打包
static/upload

# === 测试与覆盖率 ===
coverage
.nyc_output
test

# === IDE 与编辑器 ===
.idea
.vscode
*.sublime-*
.DS_Store

# === 文档与笔记 ===
# 学习笔记不需要进入生产镜像
docs
*.md
!README.md

# === Cursor AI 配置 ===
.cursor

# === AI 上下文镜像文件 ===
env.ai

# === 临时文件 ===
.temp
.tmp
*.swp
*.swo

```

### Step 2: 创建 Dockerfile

**这一步在干什么**：定义多阶段构建流程，第一阶段编译 TypeScript，第二阶段仅保留生产运行时必需文件。

```bash
# 文件路径: Dockerfile
```

```dockerfile
# ============================================================
# NestJS Production Dockerfile (Multi-stage Build)
# ============================================================
# 多阶段构建策略：
# 1. builder 阶段：安装全部依赖 + 编译 TypeScript
# 2. production 阶段：仅安装生产依赖 + 复制编译产物
# 
# 优势：生产镜像体积约 150-180MB（对比单阶段 1GB+）

# ============================================================
# Stage 1: Builder - 构建阶段
# ============================================================
FROM node:22-alpine AS builder

# 设置工作目录
WORKDIR /app

# 先复制依赖清单文件（利用 Docker 层缓存）
# 只有 package*.json 变化时才会重新 npm ci
COPY package*.json ./

# 安装全部依赖（包括 devDependencies，用于编译）
# npm ci 比 npm install 更快且确定性安装
RUN npm ci

# 复制源代码
COPY . .

# 编译 TypeScript -> JavaScript
RUN npm run build

# ============================================================
# Stage 2: Production - 生产阶段
# ============================================================
FROM node:22-alpine AS production

# 设置 Node.js 生产环境标识
ENV NODE_ENV=production

# 设置工作目录
WORKDIR /app

# 先复制依赖清单文件
COPY package*.json ./

# 仅安装生产依赖（排除 devDependencies）
# --omit=dev 是 npm 8+ 的标准写法
RUN npm ci --omit=dev

# 从 builder 阶段复制编译产物
COPY --from=builder /app/dist ./dist

# 生产环境需要写入日志与本地上传目录，提前创建并赋权给非 root 用户避免 EACCES
RUN mkdir -p logs static/upload && chown -R node:node /app

# 创建非 root 用户运行应用（安全最佳实践）
# Alpine 镜像自带 node 用户，直接使用即可
USER node

# 暴露应用端口（文档性声明，实际端口由 APP_PORT 环境变量控制）
EXPOSE 3000

# 健康检查配置
# 使用轻量级的 liveness 端点，避免检查外部依赖导致误判
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${APP_PORT:-3000}/health/liveness || exit 1

# 启动命令
# 使用 node 直接运行，确保 SIGTERM 信号正确传递（优雅关闭）
# TypeScript 的输出目录结构包含 src（例如 dist/src/...），与项目的 typeorm 脚本保持一致
CMD ["node", "dist/src/main.js"]

```

### Step 3: 更新 docker-compose.yml

**这一步在干什么**：在编排文件中添加 `app` 服务定义，配置环境变量、依赖关系和健康检查。

```yaml
version: '3.8'

# ============================================================
# 服务组说明：
# - 基础设施服务：postgres, redis（无 profile，始终可用）
# - 开发工具服务：pgadmin, redis-insight（dev profile）
# - 应用服务：app（prod profile）
# 
# 使用方式：
# - 本地开发：docker compose --profile dev up -d（数据库 + 可视化工具）
# - 生产部署：docker compose --profile prod up -d --build（应用 + 数据库）
# - 仅数据库：docker compose up -d（最简模式）
# ============================================================

services:
  # === NestJS 应用服务 ===
  # 仅在 prod profile 下启动
  app:
    profiles: [prod]
    build:
      context: .
      dockerfile: Dockerfile
    container_name: nest-journey-app
    restart: unless-stopped
  
    # 端口映射：宿主机 3000 -> 容器 3000
    ports:
      - "${APP_PORT:-3000}:${APP_PORT:-3000}"
  
    # 环境变量配置
    environment:
      # 应用配置
      APP_ENV: ${APP_ENV:-production}
      APP_PORT: ${APP_PORT:-3000}
    
      # 数据库配置（容器网络内使用服务名作为主机名）
      DB_HOST: postgres
      DB_PORT: 5432
      DB_NAME: ${DB_NAME}
      DB_USER: ${DB_USER}
      DB_PASS: ${DB_PASS}
      DB_SYNCHRONIZE: "false"
      DB_LOGGING: ${DB_LOGGING:-false}
    
      # Redis 配置（容器网络内使用服务名作为主机名）
      REDIS_HOST: redis
      REDIS_PORT: 6379
      REDIS_PASSWORD: ${REDIS_PASSWORD}
      REDIS_DB: ${REDIS_DB:-0}
    
      # JWT 配置
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET}
      JWT_REFRESH_SECRET: ${JWT_REFRESH_SECRET}
      JWT_ACCESS_EXPIRES_IN: ${JWT_ACCESS_EXPIRES_IN:-15m}
      JWT_REFRESH_EXPIRES_IN: ${JWT_REFRESH_EXPIRES_IN:-7d}
    
      # 存储配置
      STORAGE_DRIVER: ${STORAGE_DRIVER:-local}
      STORAGE_LOCAL_DIR: ${STORAGE_LOCAL_DIR:-static/upload}
      STORAGE_LOCAL_PREFIX: ${STORAGE_LOCAL_PREFIX:-/static/upload}
    
      # CORS 配置
      CORS_ORIGINS: ${CORS_ORIGINS:-}
    
      # 日志配置
      LOG_LEVEL: ${LOG_LEVEL:-warn}
      LOG_ON_CONSOLE: ${LOG_ON_CONSOLE:-false}
  
    # 依赖服务：确保数据库和 Redis 先启动
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
  
    # 健康检查（使用 Dockerfile 内置的 HEALTHCHECK，此处可覆盖）
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:${APP_PORT:-3000}/health/liveness"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
  
    # 资源限制（可选，生产环境建议开启）
    # deploy:
    #   resources:
    #     limits:
    #       cpus: '1'
    #       memory: 512M
    #     reservations:
    #       cpus: '0.5'
    #       memory: 256M

  # === PostgreSQL 服务 ===
  postgres:
    # 镜像：使用官方 PostgreSQL 16 镜像（当前最新稳定版）
    image: postgres:16
  
    # 容器名称：带上项目前缀，避免与其他项目冲突 给运行起来的进程起个名，方便查找
    container_name: nest-journey-postgres
  
    # 自动重启：如果你重启电脑或 Docker，数据库会自动重新启动
    restart: always
  
    # 环境变量：设置初始的超级用户账号和默认数据库
    environment:
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASS}
      POSTGRES_DB: ${DB_NAME}
  
    # 端口映射
    # 格式："宿主机端口:容器内部端口"
    # PostgreSQL 默认端口是 5432  将电脑的 5432 端口流量，通过网桥转发给容器内的 5432 端口
    ports:
      - "5432:5432"
  
    # 数据挂载 
    # 格式："宿主机路径:容器内部路径"
    # 作用：将容器里存数据的 /var/lib/postgresql/data 目录，直接映射到你当前项目下的 ./postgres-data 文件夹
    # 结果：你的数据实际上是存在你眼前的项目文件夹里的，而不是藏在 Docker 里的
    # PostgreSQL 数据目录是 /var/lib/postgresql/data
    volumes:
      - ./postgres-data:/var/lib/postgresql/data
  
    # 健康检查：用于 app 服务的 depends_on condition
    healthcheck:
      # 使用容器内环境变量，避免宿主机未注入 DB_* 时健康检查失效
      # 这里需要用 $$ 转义，否则 docker compose 会把 $POSTGRES_* 当作宿主机变量插值
      test: ["CMD-SHELL", "pg_isready -U \"$$POSTGRES_USER\" -d \"$$POSTGRES_DB\""]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s

  # === pgAdmin 服务 (Web管理端) ===
  # 仅在 dev profile 下启动
  pgadmin:
    profiles: [dev]
    image: dpage/pgadmin4
    container_name: nest-journey-pgadmin
    restart: always
    environment:
      PGADMIN_DEFAULT_EMAIL: "admin@admin.com"
      PGADMIN_DEFAULT_PASSWORD: "admin"
    ports:
      - "5050:80"
    # 持久化配置，避免每次重启都要重新添加服务器连接
    volumes:
      - ./pgadmin-data:/var/lib/pgadmin
    depends_on:
      - postgres

  # === Redis 服务 ===
  redis:
    # 镜像：使用官方 Redis 7.2 版本 (目前较新的稳定版)
    image: redis:7.2
  
    # 容器名称
    container_name: nest-journey-redis
  
    # 自动重启
    restart: always
  
    # 启动命令：开启 AOF 持久化 (默认是关闭的，开启后数据更安全)
    # --requirepass 使用环境变量 ${REDIS_PASSWORD}
    # --maxmemory 512mb: 限制最大内存使用量
    # --maxmemory-policy allkeys-lru: 内存满时的淘汰策略
    command: redis-server --appendonly yes --requirepass "${REDIS_PASSWORD}" --maxmemory 512mb --maxmemory-policy allkeys-lru
  
    # 端口映射：宿主机 6379 -> 容器 6379
    ports:
      - "6379:6379"
  
    # 数据挂载：把 Redis 数据存在当前目录下的 ./redis-data 文件夹
    volumes:
      - ./redis-data:/data

  # === Redis Insight 服务 (Web管理端) ===
  # 仅在 dev profile 下启动
  redis-insight:
    profiles: [dev]
    image: redis/redisinsight:latest
    container_name: nest-journey-redis-insight
    restart: always
    ports:
      - "5540:5540"
    # 持久化配置，避免每次重启都要重新添加 Redis 连接
    volumes:
      - ./redis-insight-data:/data
    depends_on:
      - redis

```

同时为 `postgres` 服务添加健康检查：

```yaml
postgres:
  # ... 其他配置
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U ${DB_USER} -d ${DB_NAME}"]
    interval: 10s
    timeout: 5s
    retries: 5
    start_period: 10s
```

### Step 4: 验证构建

**这一步在干什么**：执行构建命令，验证镜像构建成功且体积符合预期。

```bash
# 构建镜像
docker build -t nest-app:test .

# 查看镜像体积（预期 150-180MB）
docker images nest-app:test

# 测试容器启动（需要数据库和 Redis 运行中）
docker compose up -d postgres redis
docker compose up --build app

# 验证健康检查
docker inspect --format='{{.State.Health.Status}}' nest-journey-app
```

### Step 5: 常用命令速查

已将常用命令封装到 npm scripts 中：

```bash
# === 本地开发模式 ===
npm run docker:dev                     # 启动数据库 + 可视化工具
npm run docker:db                      # 仅启动数据库（最简）
npm run dev                            # 本地运行 Node

# === 生产部署模式 ===
npm run docker:prod                    # 构建并启动生产服务
npm run docker:logs                    # 查看应用日志
npm run docker:down                    # 停止所有服务

# === 镜像管理 ===
docker compose build app               # 仅重新构建 app 镜像
docker image prune -f                  # 清理悬空镜像
```

**npm scripts 对照表**：

| 脚本            | 原始命令                                             |
| --------------- | ---------------------------------------------------- |
| `docker:dev`  | `docker compose --profile dev up -d`               |
| `docker:prod` | `docker compose --profile prod up -d --build`      |
| `docker:db`   | `docker compose up -d`                             |
| `docker:down` | `docker compose --profile dev --profile prod down` |
| `docker:logs` | `docker compose logs -f app`                       |
