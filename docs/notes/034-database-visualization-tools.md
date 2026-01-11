# 034. 数据库可视化管理工具集成 (Database Visualization Tools)

## 1. 核心问题与概念

### 解决什么问题

需要直观地验证数据库表结构是否正确、检查写入的数据内容，或者调试 Redis 中的 Key-Value 状态。虽然可以通过命令行查看，但可视化的 Web 管理工具能提供更高效、直观的调试体验。

### 核心概念与依赖

- **pgAdmin**: PostgreSQL 官方推出的 Web 管理工具，功能全面但操作相对繁琐。
- **Redis Insight**: Redis 官方推出的 Web 管理工具，界面现代，操作直观。
- **Docker 内部网络**: 当管理工具和数据库都运行在 Docker Compose 编排的容器中时，它们通过 Docker 内部网络（Bridge Network）通信。连接时使用的是**服务名**（如 `postgres`、`redis`），而非 `localhost` 或 `127.0.0.1`。

### 开发环境 vs 生产环境

| 环境               | 查看方式                                                                                                                               | 安全策略                                          |
| :----------------- | :------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------ |
| **开发环境** | Docker 集成 Web UI (pgAdmin/Redis Insight)，通过浏览器直接访问 `localhost`                                                           | 端口开放，方便调试                                |
| **生产环境** | **本地客户端 + SSH 隧道**：使用 DBeaver/Navicat 等桌面客户端，通过 SSH 加密通道连接。**绝不在服务器上部署 Web 管理面板**。 | 数据库端口不对公网开放，仅通过 SSH 端口 (22) 访问 |

## 2. 方案设计 (Design)

### 场景: Docker Compose 集成可视化工具

在 `docker-compose.yml` 中添加 `pgadmin` 和 `redis-insight` 服务，与数据库服务在同一网络中，实现一键启动开发环境。

```yaml
# docker-compose.yml (新增部分)

  # === pgAdmin 服务 (Web管理端) ===
  pgadmin:
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

  # === Redis Insight 服务 (Web管理端) ===
  redis-insight:
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

### 关键配置说明

1. **`volumes` 持久化**: 将工具的配置数据（如已添加的服务器连接）挂载到宿主机目录。否则每次 `docker-compose down` 后，配置会丢失，需要重新添加连接。
2. **`depends_on`**: 确保管理工具在数据库服务启动后再启动。
3. **`.gitignore` 更新**: 新增的数据目录需要被 Git 忽略。
   ```gitignore
   # Database admin tools data
   pgadmin-data/
   redis-insight-data/
   ```

## 3. 深度原理与机制 (Under the Hood)

### Docker 内部网络通信

```
┌─────────────────────────────────────────────────────────────────┐
│                     Docker Compose Network                      │
│                                                                 │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────────┐ │
│  │  postgres   │◄────►│   pgadmin   │      │  redis-insight  │ │
│  │  (5432)     │      │   (80)      │      │    (5540)       │ │
│  └─────────────┘      └──────┬──────┘      └────────┬────────┘ │
│         ▲                    │                      │          │
│         │                    │                      │          │
│  ┌──────┴──────┐             │              ┌───────┴───────┐  │
│  │    redis    │◄────────────┼──────────────┤               │  │
│  │   (6379)    │             │              │               │  │
│  └─────────────┘             │              │               │  │
└──────────────────────────────┼──────────────┼───────────────┘  │
                               │              │                 
                               ▼              ▼                 
                    ┌──────────────────────────────┐            
                    │        宿主机 (Host)          │            
                    │  localhost:5050  (pgAdmin)   │            
                    │  localhost:5540  (RedisInsight)│            
                    └──────────────────────────────┘            
```

- 容器之间通过**服务名**（`postgres`, `redis`）互相访问，这是 Docker DNS 自动解析的。
- 宿主机通过 `ports` 映射的端口（`5050`, `5540`）访问容器内的服务。

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

- ✅ **使用 volumes 持久化管理工具的配置**，避免每次重启都要重新配置连接。
- ✅ **在 Docker 内部连接时使用服务名**（如 `postgres`），而非 `localhost`。
- ✅ **将管理工具的数据目录加入 `.gitignore`**。
- ❌ **不要在生产环境部署 Web 管理面板**，这会暴露数据库给潜在攻击者。
- ❌ **不要使用 `127.0.0.1` 作为容器间通信地址**，这会导致连接失败（因为每个容器有自己的 localhost）。

### 关于 pgAdmin 的使用体验

pgAdmin 是 PostgreSQL 官方工具，功能强大但交互相对繁琐（需要多次点击才能看到表数据）。如果追求更好的使用体验，可以考虑以下替代方案：

| 工具                      | 类型               | 优点                     | 缺点                |
| :------------------------ | :----------------- | :----------------------- | :------------------ |
| **DBeaver**         | 桌面客户端 (免费)  | 功能全面，支持多种数据库 | Java 应用，启动稍慢 |
| **TablePlus**       | 桌面客户端 (付费)  | 界面现代，速度极快       | 免费版有限制        |
| **Navicat**         | 桌面客户端 (付费)  | 操作最傻瓜化，体验最好   | 价格较高            |
| **Database Client** | VSCode/Cursor 插件 | 无需切换窗口             | 功能相对基础        |

## 5. 行动导向 (Action Guide)

### Step 1: 更新 docker-compose.yml

**这一步在干什么**: 在 Docker Compose 编排文件中声明 pgAdmin 和 Redis Insight 服务，使其与数据库服务在同一网络中运行。

```yaml
# 在 docker-compose.yml 的 services 下添加以下内容

  # === pgAdmin 服务 (Web管理端) ===
  pgadmin:
    image: dpage/pgadmin4
    container_name: nest-journey-pgadmin
    restart: always
    environment:
      PGADMIN_DEFAULT_EMAIL: "admin@admin.com"
      PGADMIN_DEFAULT_PASSWORD: "admin"
    ports:
      - "5050:80"
    volumes:
      - ./pgadmin-data:/var/lib/pgadmin
    depends_on:
      - postgres

  # === Redis Insight 服务 (Web管理端) ===
  redis-insight:
    image: redis/redisinsight:latest
    container_name: nest-journey-redis-insight
    restart: always
    ports:
      - "5540:5540"
    volumes:
      - ./redis-insight-data:/data
    depends_on:
      - redis
```

### Step 2: 更新 .gitignore

**这一步在干什么**: 将管理工具产生的本地数据目录加入忽略列表，防止敏感配置信息（如数据库连接凭证）被提交到 Git 仓库。

```gitignore
# Database admin tools data
pgadmin-data/
redis-insight-data/
```

### Step 3: 启动 Docker 服务

**这一步在干什么**: 使用 Docker Compose 拉取镜像并启动所有服务。首次拉取 pgAdmin 镜像可能需要较长时间（约 800MB-1GB）。

```bash
docker-compose up -d
```

### Step 4: 配置 pgAdmin 连接 PostgreSQL

**这一步在干什么**: 在 pgAdmin Web 界面中注册 PostgreSQL 服务器，建立管理连接。

1. **访问地址**: 浏览器打开 `http://localhost:5050`
2. **登录账号**: `admin@admin.com`
3. **登录密码**: `admin`
4. **添加服务器连接**:

   - 左侧菜单: 右键点击 `Servers` -> `注册` -> `服务器...`
   - **常规 (General)** 标签页:
     - 名称: 填入任意名称（如 `local`）
   - **连接 (Connection)** 标签页:
     - 主机名称/地址: `postgres` (Docker 服务名)
     - 端口: `5432`
     - 维护数据库: `postgres`
     - 用户名: `postgres` (对应 env 中的 DB_USER)
     - 密码: `123456` (对应 env 中的 DB_PASS)
     - 勾选: `保存密码`
   - 点击 `保存`
5. **查看表数据**:

   - 左侧展开: `local` -> `数据库` -> `nest_journey` -> `架构` -> `public` -> `表`
   - 可以看到 `migrations`, `roles`, `users` 等表
   - **右键点击表名** -> `查看/编辑数据` -> `所有行` 即可查看数据

### Step 5: 配置 Redis Insight 连接 Redis

**这一步在干什么**: 在 Redis Insight Web 界面中添加 Redis 实例，建立管理连接。

1. **访问地址**: 浏览器打开 `http://localhost:5540`
2. **首次访问**: 会显示 EULA 和隐私设置页面
   - 勾选最底部的 `I have read and understood the Terms`
   - 点击 `Submit`
3. **添加 Redis 连接**:
   - 点击 `+ Connect existing database`
   - **Connection URL** 方式:
     - 将默认的 `redis://default@127.0.0.1:6379` 修改为:
     - `redis://:123456@redis:6379`
     - (格式: `redis://[:password]@[host]:[port]`)
   - 或点击 `Connection settings` 使用表单方式:
     - Host: `redis`
     - Port: `6379`
     - Password: `123456` (对应 env 中的 REDIS_PASSWORD)
   - 点击 `Add database`
4. **查看数据**:
   - 在列表中点击刚添加的 `redis:6379` 实例卡片
   - 左侧 `Browser` 可查看所有 Key
   - 点击具体 Key 可在右侧查看 Value 内容

### 访问信息速查表

| 服务          | 访问地址                  | 账号                | 密码      | 连接数据库时的 Host |
| :------------ | :------------------------ | :------------------ | :-------- | :------------------ |
| pgAdmin       | `http://localhost:5050` | `admin@admin.com` | `admin` | `postgres`        |
| Redis Insight | `http://localhost:5540` | -                   | -         | `redis`           |
