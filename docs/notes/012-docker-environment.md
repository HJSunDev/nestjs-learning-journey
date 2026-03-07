# 012. Docker 开发环境与项目启动指南

## 1. 核心问题与概念 (The "Why")

### 解决什么问题

NestJS 应用依赖 PostgreSQL、Redis 等外部服务。在开发机上直接安装这些服务存在以下痛点：

1. **环境污染**：数据库安装后残留注册表、系统服务，卸载不干净
2. **版本冲突**：多个项目可能需要不同版本的 PostgreSQL 或 Redis
3. **团队一致性**：每个人的本地环境配置不同，导致"在我机器上能跑"的问题

Docker Compose 将所有基础设施声明在一个 `docker-compose.yml` 文件中，`docker compose up -d` 即可拉起完整环境，`docker compose down` 即可销毁，数据通过 Volume 挂载持久化到项目目录。

### 核心概念与依赖

| 概念                         | 角色         | 说明                                                                                 |
| ---------------------------- | ------------ | ------------------------------------------------------------------------------------ |
| **Docker Desktop**     | 运行时引擎   | 在 Windows/Mac 上提供 Linux 容器运行环境，**不启动它所有 Docker 命令都会报错** |
| **docker-compose.yml** | 编排清单     | 声明所有服务（数据库、缓存、管理工具、应用）及其配置                                 |
| **Profile**            | 服务分组机制 | 按用途将服务分为"基础设施"、"开发工具"、"生产应用"三组，按需启动                     |
| **Volume 挂载**        | 数据持久化   | 将容器内数据目录映射到宿主机文件夹，容器删除后数据仍在                               |
| **.env**               | 环境变量注入 | docker compose 自动读取项目根目录的 `.env` 文件，注入到服务配置中                  |

### 当前服务架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                    docker-compose.yml                           │
├──────────────────┬──────────────────┬───────────────────────────┤
│  基础设施服务     │  开发工具服务     │  应用服务                  │
│  (无 profile)    │  (dev profile)   │  (prod profile)           │
│  始终可用         │  本地开发时启动   │  生产部署时启动            │
├──────────────────┼──────────────────┼───────────────────────────┤
│  postgres:16     │  pgadmin4        │  app (NestJS)             │
│  ↳ :5432         │  ↳ :5050         │  ↳ :3000                  │
│                  │                  │                           │
│  redis:7.2       │  redis-insight   │  基于 Dockerfile          │
│  ↳ :6379         │  ↳ :5540         │  多阶段构建                │
└──────────────────┴──────────────────┴───────────────────────────┘
```

## 2. 三种启动模式 (Usage / Design)

项目通过 Docker Compose 的 **Profile 机制** 提供三种启动模式，对应不同的使用场景。

### 模式 A: 本地开发模式（最常用）

**场景**：日常写代码、调试功能。Node.js 在本地运行（支持热重载），数据库和工具在 Docker 中运行。

```bash
# 第 1 步：启动基础设施 + 可视化管理工具
npm run docker:dev

# 第 2 步：本地启动 NestJS（热重载）
npm run dev
```

**启动的服务**：

| 服务          | 容器名                     | 访问地址              | 用途             |
| ------------- | -------------------------- | --------------------- | ---------------- |
| PostgreSQL 16 | nest-journey-postgres      | localhost:5432        | 主数据库         |
| Redis 7.2     | nest-journey-redis         | localhost:6379        | 缓存/Token 存储  |
| pgAdmin 4     | nest-journey-pgadmin       | http://localhost:5050 | 数据库可视化管理 |
| Redis Insight | nest-journey-redis-insight | http://localhost:5540 | Redis 可视化管理 |

**优势**：代码修改即时生效、IDE 断点调试正常、避免 Docker Volume 在 Windows/macOS 上的 I/O 性能问题。

### 模式 B: 仅数据库模式（最简）

**场景**：不需要可视化工具，只想启动数据库和 Redis。

```bash
npm run docker:db
```

**启动的服务**：仅 PostgreSQL + Redis（无 pgAdmin、无 Redis Insight）。

搭配 `npm run dev` 在本地运行 NestJS。

### 模式 C: 生产部署模式（全容器化）

**场景**：模拟生产环境或实际部署。NestJS 应用也运行在容器中。

```bash
npm run docker:prod
```

**启动的服务**：PostgreSQL + Redis + NestJS App（通过 Dockerfile 多阶段构建）。

应用通过 `depends_on` + 健康检查确保 PostgreSQL 就绪后再启动。容器网络内服务间通过服务名（`postgres`、`redis`）通信，而非 `localhost`。

> 生产构建的 Dockerfile 细节参见 [037. 生产级 Docker 构建](037-production-dockerfile.md)。

## 3. 深度原理与机制 (Under the Hood)

### Profile 机制工作原理

docker-compose.yml 中通过 `profiles` 字段对服务进行分组：

```yaml
services:
  # 无 profiles 字段 → 任何模式都会启动
  postgres:
    image: postgres:16
    # ...

  # profiles: [dev] → 仅 --profile dev 时启动
  pgadmin:
    profiles: [dev]
    # ...

  # profiles: [prod] → 仅 --profile prod 时启动
  app:
    profiles: [prod]
    # ...
```

**规则**：没有 `profiles` 字段的服务（postgres、redis）在所有模式下都会启动。带有 `profiles` 的服务只在显式指定对应 profile 时才启动。

### .env 自动注入

docker compose 在执行时会自动读取项目根目录的 `.env` 文件。`docker-compose.yml` 中使用 `${VAR_NAME}` 语法引用变量：

```yaml
environment:
  POSTGRES_USER: ${DB_USER}        # 从 .env 中读取 DB_USER
  POSTGRES_PASSWORD: ${DB_PASS}    # 从 .env 中读取 DB_PASS
```

因此 `.env` 文件是 Docker 环境和 NestJS 应用共享的唯一配置源，无需维护两份配置。

### 数据卷挂载

各服务的数据通过 Volume 挂载到项目根目录下的对应文件夹：

| 服务          | 容器内路径               | 宿主机路径            | 说明           |
| ------------- | ------------------------ | --------------------- | -------------- |
| PostgreSQL    | /var/lib/postgresql/data | ./postgres-data/      | 数据库文件     |
| Redis         | /data                    | ./redis-data/         | AOF 持久化文件 |
| pgAdmin       | /var/lib/pgadmin         | ./pgadmin-data/       | 连接配置       |
| Redis Insight | /data                    | ./redis-insight-data/ | 连接配置       |

这些目录已在 `.gitignore` 中排除，**不会被提交到 Git**。

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

### ✅ 推荐做法

1. **先启动 Docker，再启动应用**：NestJS 启动时会尝试连接数据库和 Redis，基础设施未就绪会报连接错误
2. **使用 npm scripts 而非裸命令**：`npm run docker:dev` 比手敲 `docker compose --profile dev up -d` 更不容易出错
3. **定期清理悬空镜像**：`docker image prune -f` 回收构建过程中产生的中间镜像

### ❌ 避免做法

1. **不要在没有 .env 文件的情况下启动**：docker-compose.yml 中的 `${DB_USER}` 等变量会变成空字符串，导致数据库创建失败
2. **不要手动修改 `*-data/` 目录中的文件**：这些是数据库引擎的内部格式，手动修改可能导致数据损坏
3. **不要把 `*-data/` 目录提交到 Git**：这些目录包含大量二进制文件，且可能包含敏感数据

### 常见问题

**Q: `docker compose up` 报 `error during connect`？**
A: Docker Desktop 没有启动。检查系统托盘是否有鲸鱼图标，确认 Docker Desktop 正在运行。

**Q: PostgreSQL 容器启动后 NestJS 仍然连不上？**
A: 确认 `.env` 文件中 `DB_HOST=localhost`（本地开发时）。如果是生产模式（容器内运行），`DB_HOST` 应为 `postgres`（服务名）。

**Q: 数据库状态想完全重置怎么办？**
A: 停止容器后删除对应的数据目录，再重新启动：

```bash
npm run docker:down
# 删除数据目录（Windows PowerShell）
Remove-Item -Recurse -Force postgres-data, redis-data
npm run docker:db
```

## 5. 行动导向 (Action Guide)

以下步骤适用于 **首次拉取项目** 或 **长时间没碰项目后恢复开发** 的场景。

### Step 1: 确保 Docker Desktop 已运行

**这一步在干什么**：Docker Desktop 是所有容器操作的前提。它在宿主机上运行一个轻量级 Linux 虚拟机，所有 Docker 命令都通过它执行。

检查系统托盘（Windows 右下角）是否有 Docker 鲸鱼图标。如果没有，手动启动 Docker Desktop 应用程序。

### Step 2: 配置环境变量

**这一步在干什么**：`.env` 文件是 Docker 服务和 NestJS 应用的共享配置源。docker compose 启动时自动读取它来填充数据库密码、端口等变量。

```bash
# 如果 .env 文件不存在，从模板复制一份
cp env.example .env

# 然后编辑 .env，填写必填项：
# - DB_USER / DB_PASS / DB_NAME（PostgreSQL 账号密码）
# - REDIS_PASSWORD（Redis 密码）
# - JWT_ACCESS_SECRET / JWT_REFRESH_SECRET（JWT 密钥）
```

### Step 3: 选择启动模式

**这一步在干什么**：根据当前需要，选择对应的启动命令。三种模式对应不同的服务组合。

```bash
# ========== 模式 A: 本地开发（最常用） ==========
# 启动：PostgreSQL + Redis + pgAdmin + Redis Insight
npm run docker:dev
# 然后本地启动 NestJS
npm run dev

# ========== 模式 B: 仅数据库（最简） ==========
# 启动：PostgreSQL + Redis
npm run docker:db
# 然后本地启动 NestJS
npm run dev

# ========== 模式 C: 生产部署（全容器化） ==========
# 启动：PostgreSQL + Redis + NestJS App（自动构建镜像）
npm run docker:prod
```

### Step 4: 验证服务状态

**这一步在干什么**：通过 `docker ps` 确认所有容器均已正常运行。`STATUS` 列显示 `Up` 表示成功。

```bash
docker ps
```

**模式 A 的预期输出**（4 个容器全部 Up）：

```text
CONTAINER ID   IMAGE                       STATUS                    PORTS                    NAMES
xxxxxxxxxxxx   postgres:16                 Up 2 min (healthy)        0.0.0.0:5432->5432/tcp   nest-journey-postgres
xxxxxxxxxxxx   redis:7.2                   Up 2 min                  0.0.0.0:6379->6379/tcp   nest-journey-redis
xxxxxxxxxxxx   dpage/pgadmin4              Up 2 min                  0.0.0.0:5050->80/tcp     nest-journey-pgadmin
xxxxxxxxxxxx   redis/redisinsight:latest   Up 2 min                  0.0.0.0:5540->5540/tcp   nest-journey-redis-insight
```

### Step 5: 日常操作速查

**这一步在干什么**：汇总所有 Docker 相关的 npm scripts，避免手敲长命令。

```bash
# === 启动 ===
npm run docker:dev       # 数据库 + 可视化工具
npm run docker:db        # 仅数据库
npm run docker:prod      # 全容器化（含 NestJS）

# === 停止 ===
npm run docker:down      # 停止并删除所有容器（数据保留在 *-data/ 目录中）

# === 调试 ===
npm run docker:logs      # 查看 NestJS 应用容器日志（仅 prod 模式有效）
docker ps                # 查看运行中的容器
docker compose logs -f   # 查看所有服务日志

# === 清理 ===
docker image prune -f    # 清理悬空镜像，回收磁盘空间
```

**npm scripts 与原始命令对照**：

| npm script      | 等价的 Docker 命令                                   | 说明                    |
| --------------- | ---------------------------------------------------- | ----------------------- |
| `docker:dev`  | `docker compose --profile dev up -d`               | 基础设施 + 开发工具     |
| `docker:db`   | `docker compose up -d`                             | 仅基础设施              |
| `docker:prod` | `docker compose --profile prod up -d --build`      | 全容器化部署            |
| `docker:down` | `docker compose --profile dev --profile prod down` | 停止所有 profile 的服务 |
| `docker:logs` | `docker compose logs -f app`                       | 跟踪应用日志            |

### 访问地址汇总

| 服务          | 地址                         | 备注                          |
| ------------- | ---------------------------- | ----------------------------- |
| NestJS API    | http://localhost:3000        | 本地开发或 prod 模式          |
| Swagger 文档  | http://localhost:3000/api/docs | 接口文档与在线调试，需先 `npm run dev` 启动应用 |
| 健康检查      | http://localhost:3000/health | 应用+依赖状态                 |
| pgAdmin       | http://localhost:5050        | 账号: admin@admin.com / admin |
| Redis Insight | http://localhost:5540        | 首次需手动添加连接            |
