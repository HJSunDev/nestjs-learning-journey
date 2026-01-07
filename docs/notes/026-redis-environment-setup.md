# 026. Redis 环境集成与 Docker 编排原理

## 1. 核心概念与技术原理 (Core Concepts & Principles)

### 1.1 Redis 的本质与特性

Redis (Remote Dictionary Server) 是一个开源的、基于内存的数据结构存储系统。

- **内存存储 (In-Memory)**: 所有数据驻留在内存中，读写速度达到微秒级（10w+ QPS），远超基于磁盘的传统数据库。
- **数据结构服务器**: 不仅仅是 Key-Value，还支持 String, List, Set, Hash, ZSet, Stream 等复杂数据结构，使其能胜任缓存、消息队列、排行榜、会话管理等多种场景。
- **原生 TTL (Time To Live) 支持**: Redis 原生支持为任意 Key 设置生存时间。它是处理验证码、Session、限流等“时效性数据”的最佳方案。相比传统数据库低效的轮询清理，Redis 采用“惰性删除 + 定期删除”策略，能自动、高效地剔除过期数据，业务层无需关心清理逻辑。
- **单线程模型与 I/O 多路复用**: Redis 核心命令处理采用单线程模型，利用 epoll (Linux) 实现 I/O 多路复用，避免了上下文切换和锁竞争的开销，这是其高性能的核心原因之一。

### 1.2 关键启动参数解析

在 `docker-compose.yml` 中，我们使用了 `redis-server --appendonly yes --requirepass "..."`，其技术含义如下：

#### `--appendonly yes` (AOF 持久化)

- **机制**: AOF (Append Only File) 是一种持久化策略。Redis 会将每一个收到的“写指令”（如 SET, LPUSH）以日志形式追加到磁盘文件中（默认为 `appendonly.aof`）。
- **Why**: 默认情况下 Redis 是纯内存运行，一旦容器重启或崩溃，数据瞬间丢失。开启 AOF 后，Redis 重启时会重新执行文件中的所有指令，从而恢复数据。
- **对比 RDB**: RDB 是定时快照（如每小时存一次），由于间隔时间长，丢数据风险大；AOF 实时性更高，是生产环境的数据安全基石。

#### `--requirepass "..."` (安全认证)

- **机制**: 启用 Redis 的简易密码认证机制。客户端连接后必须发送 `AUTH <password>` 指令才能执行其他命令。
- **Why**: Redis 默认绑定在 0.0.0.0 且无密码。如果不设置密码，暴露在公网的 Redis 极易被利用植入挖矿脚本或被勒索。

### 1.3 内存限制与淘汰策略 (Memory Management)

**配置示例**: `--maxmemory 512mb --maxmemory-policy allkeys-lru`

#### 为什么要限制内存？(The Why)
在典型的 4GB 内存云服务器上，资源分配非常紧张：
- **操作系统 (OS)**: 需占用约 0.5GB - 1GB。
- **MongoDB**: 数据库是吃内存大户，通常需预留 1.5GB+ 用于索引和缓存。
- **Node.js 应用**: NestJS 运行时需占用 0.5GB 左右。

如果 Redis 不设限制，作为纯内存数据库，它会倾向于吞噬剩余所有内存。一旦总内存耗尽，Linux 的 **OOM Killer (内存溢出杀手)** 会介入，通常会优先杀死占用内存最大的进程（往往是 MongoDB 或 Redis 本身），导致服务雪崩。

#### 设置后会发生什么？(The How)
通过 `--maxmemory 512mb` 我们给 Redis 划定了“安全红线”。当存储的数据量达到 512MB 时，Redis **不会崩溃**，而是触发 `--maxmemory-policy` 指定的策略：

- **allkeys-lru**: 自动删除**最近最少使用 (Least Recently Used)** 的键，为新数据腾出空间。
- **结果**: Redis 变身为一个永远不会溢出的“智能缓存”，自动淘汰冷数据，保留热数据，既保护了服务器稳定，又维持了服务可用性。

#### 512MB 够用吗？(Capacity Estimation)
对于绝大多数中型应用，512MB 是绰绰有余的。基于 Redis 高效的内存编码，估算如下：

1.  **用户 Session/Token**:
    - 假设每条数据占用 300 字节（包含 Key 和用户信息 JSON）。
    - **容量**: 可存储约 **150 万** 个在线用户会话。
2.  **简单验证码**:
    - 假设每条占用 80 字节。
    - **容量**: 可存储约 **600 万** 条验证码。
3.  **接口缓存**:
    - 假设每个接口响应 5KB。
    - **容量**: 可缓存约 **10 万** 个不同的接口响应结果。
    - 配合 `allkeys-lru` 策略，这 10 万个永远是最热、被访问最频繁的数据。

### 1.4 数据库资源消耗对比 (Resource Comparison)

在规划服务器资源时，不同数据库的内存“性格”差异巨大：

| 特性 | MongoDB (文档型) | MySQL (关系型) | Redis (内存型) |
| :--- | :--- | :--- | :--- |
| **内存机制** | **吃光所有可用内存** (WiredTiger 引擎)。它极度依赖文件系统缓存来提升性能。如果限制太死 (如 <1GB)，性能会呈指数级下降。 | **预分配机制** (InnoDB Buffer Pool)。通常手动指定固定大小 (如 `innodb_buffer_pool_size=1G`)。它比较克制，给多少用多少。 | **纯内存存储**。数据全在内存，受 `maxmemory` 严格限制。 |
| **最小启动** | 较高。空跑也建议预留 500MB+。 | 中等。空跑 200MB 也能稳住。 | 极低。空跑仅需几 MB。 |
| **4GB服务器建议** | 建议分配 **1.5GB - 2GB**。它是资源大户，必须优先满足。 | 建议分配 **1GB - 1.5GB**。根据数据量调整 Buffer Pool。 | **256MB - 512MB**。作为缓存层，它是最灵活的，可以按需调整。 |

**架构选型建议**:
- 如果项目初期资金有限 (如单台 2GB/4GB 服务器)，同时运行 MongoDB + Redis + Node.js 会非常吃力。
- **MySQL** 在小内存环境下 (如 1GB 内存限制) 的表现通常比 **MongoDB** 更稳定，因为它的内存模型更可控。如果您后续打算迁移到 MySQL，在低配服务器上会更容易运维。

### 1.5 生产环境部署最佳实践 (Production Best Practices)

从开发环境（Docker Desktop）迁移到生产服务器（Linux Server）时，必须关注以下差异：

1.  **版本锁定**: 严禁使用 `latest` 标签，必须锁定具体版本（如 `redis:7.2.4`），防止自动升级导致的不兼容或意外 Bug。
2.  **配置解耦**: 密码绝对不能硬编码在 `docker-compose.yml` 中，必须通过环境变量（`.env`）注入。
3.  **持久化策略优化**: 生产环境建议同时开启 RDB（快照，用于快速恢复）和 AOF（追加日志，用于保证数据不丢失），即混合持久化。
4.  **资源限制**: 必须在 Docker Compose 中配置 `deploy.resources.limits`，限制 Redis 的最大内存使用量（例如 `maxmemory 2gb`），防止 Redis 吃光服务器内存导致宿主机死机（OOM）。
5.  **网络隔离**: Redis 端口（6379）不应直接暴露给公网，应通过 Docker 内部网络供后端服务访问，或配置防火墙白名单。

---

## 2. 行动指南 (Action Guide)

本节包含完整的配置代码，旨在快速建立一个安全、持久化的本地 Redis 开发环境。

### Step 1: 编写 Docker 编排配置

**操作目标**: 在 `docker-compose.yml` 中定义 Redis 服务，挂载数据卷并配置启动命令。

```yaml
version: '3.8'
services:
  # === MongoDB 服务 ===
  mongo:
    # 镜像：使用官方 MongoDB 6.0 镜像 Docker 会去下载 MongoDB 6.0 版本的 Linux 运行环境
    image: mongo:6.0
  
    # 容器名称：带上项目前缀，避免与其他项目冲突 给运行起来的进程起个名，方便查找
    container_name: nest-journey-mongo
  
    # 自动重启：如果你重启电脑或 Docker，数据库会自动重新启动
    restart: always
  
    # 环境变量：设置初始的 root 用户账号密码
    # ⚠️ 这里的 ${DB_USER} 和 ${DB_PASS} 会自动读取 .env 文件中的值
    environment:
      MONGO_INITDB_ROOT_USERNAME: ${DB_USER}
      MONGO_INITDB_ROOT_PASSWORD: ${DB_PASS}
  
    # 端口映射
    # 格式："宿主机端口:容器内部端口"
    # 作用：将你电脑的 27017 端口流量，通过网桥转发给容器内的 27017 端口
    ports:
      - "27017:27017"
  
    # 数据挂载 
    # 格式："宿主机路径:容器内部路径"
    # 作用：将容器里存数据的 /data/db 目录，直接映射到你当前项目下的 ./mongo-data 文件夹
    # 结果：你的数据实际上是存在你眼前的项目文件夹里的，而不是藏在 Docker 里的
    volumes:
      - ./mongo-data:/data/db
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
    # --maxmemory 512mb: 限制最大内存使用量 (4G服务器建议预留给数据库和应用)
    # --maxmemory-policy allkeys-lru: 内存满时的淘汰策略（删除最近最少使用的key）
    command: redis-server --appendonly yes --requirepass "${REDIS_PASSWORD}" --maxmemory 512mb --maxmemory-policy allkeys-lru
  
    # 端口映射：宿主机 6379 -> 容器 6379
    ports:
      - "6379:6379"
  
    # 数据挂载：把 Redis 数据存在当前目录下的 ./redis-data 文件夹
    volumes:
      - ./redis-data:/data
```

### Step 2: 注入环境变量

**操作目标**: 在 `.env` 文件中定义连接信息，供 NestJS 应用读取。

```properties
# === Redis 配置 ===
# 开发环境通常为 localhost，生产环境可能为 Docker 服务名或专用 IP
REDIS_HOST=localhost
REDIS_PORT=6379
# 强密码策略
REDIS_PASSWORD=123456
# Redis 默认有 16 个库 (0-15)，通常使用 0 号库
REDIS_DB=0
```

### Step 3: 配置 Git 忽略规则

**操作目标**: 屏蔽二进制数据文件，防止污染代码仓库。

在项目根目录 `.gitignore` 文件中追加：

```gitignore
# Redis 持久化数据 (包含 appendonly.aof 等二进制文件)
redis-data/
```

### Step 4: 启动与验证

**操作目标**: 拉取镜像、启动容器并验证服务可用性。

在终端执行：

```bash
# 1. 后台启动所有服务 (如果已启动，会重建变更的容器)
docker-compose up -d

# 2. 检查容器状态
# 预期结果: STATUS 显示 Up，PORTS 显示 0.0.0.0:6379->6379/tcp
docker ps

# 3. (可选) 进入容器验证密码
docker exec -it nest-journey-redis redis-cli
# 进入交互界面后输入:
# auth 123456
# ping
# 预期输出: PONG
```
