# 012. 本地开发环境数据库搭建 (Docker Compose)

## 1. 场景与目标 (Context)

- **场景**: 我们正在开发 NestJS 应用，需要连接 MongoDB 数据库。
- **痛点**: 直接在开发机（Windows/Mac）上安装 MongoDB 软件步骤繁琐，且容易在系统里残留垃圾文件。
- **解决方案**: 使用 Docker 运行一个临时的 MongoDB **容器**。用完即走，但数据保存在我们指定的本地文件夹中。

## 2. 核心前置：Docker Desktop

在执行任何命令之前，你需要先安装并运行 **Docker Desktop**。

- **它是干嘛的？**:
  - Docker 引擎本身是运行在 Linux 上的。
  - 在 Windows/Mac 上，Docker Desktop 负责在后台默默运行一个极其轻量级的 Linux 虚拟机，并把你的命令行指令（如 `docker ...`）转发给这个虚拟机执行。
  - **简单理解**: 它就是 Docker 的“运行器”或“驱动”，**不打开它，所有 Docker 命令都会报错**（通常报 `error during connect...`）。

## 3. 核心概念辨析：镜像 vs 容器 (Image vs Container)

为什么第一次慢、后面快：

- **镜像 (Image)**: 相当于**安装包** (例如 `mongo:6.0` 只有几百MB)。
  - 第一次 `up` 时，Docker 发现本地没有这个“安装包”，所以会去互联网下载（Pull），这个过程**非常慢**。
  - 下载一次后，它就永久缓存在你的电脑里了。
- **容器 (Container)**: 相当于**运行实例** (运行起来的程序)。
  - `up` 是基于镜像创建并启动容器。
  - `down` 是停止并删除这个运行实例（容器）。

**关键点**:

- `docker-compose down` 删除的是**容器**（运行实例），**不是镜像**（安装包）。
- 所以下一次你再运行 `up`，Docker 发现本地已经有 `mongo:6.0` 的**镜像**了，就不需要下载了，直接“秒开”一个新的容器。

## 4. 快速开始 (Quick Start)

### Step 1: 确保 Docker Desktop 已运行

看一眼你电脑的任务栏（右下角或右上角），确认有 Docker 的鲸鱼图标 🐳 正在运行。

### Step 2: 启动数据库

在项目根目录下（即 `docker-compose.yml` 所在目录），打开终端运行：

```bash
# -d 表示在后台运行 (detached mode)，不会占用当前终端窗口
docker-compose up -d
```

*注：如果是第一次运行，会下载镜像（慢）；以后运行，直接启动（快）。*

### Step 3: 验证是否成功

最简单的验证方式是查看容器进程列表：

```bash
docker ps
```

**成功标志**:
你会看到类似的一行输出，关键看 `STATUS` 是 `Up ...`，且 `PORTS` 里有 `0.0.0.0:27017->27017/tcp`。

```text
CONTAINER ID   IMAGE       STATUS         PORTS                      NAMES
a1b2c3d4e5f6   mongo:6.0   Up 2 minutes   0.0.0.0:27017->27017/tcp   nest-journey-mongo
```

### Step 4: 常用操作

```bash
# 停止数据库 (暂停运行，容器还在，下次启动只需 docker-compose start)
docker-compose stop

# 停止并删除容器 (彻底清理运行实例)
# 下次 up 时会重新创建一个新容器，但镜像还在，所以很快
docker-compose down
```

## 5. 配置详解 (Configuration)

文件：`docker-compose.yml`

```yaml
version: '3.8'
services:
  # 服务名称
  mongo:
    # 镜像：使用官方 MongoDB 6.0 镜像 Docker 会去下载 MongoDB 6.0 版本的 Linux 运行环境
    image: mongo:6.0
  
    # 容器名称：带上项目前缀，避免与其他项目冲突 给运行起来的进程起个名，方便查找
    container_name: nest-journey-mongo
  
    # 自动重启：如果你重启电脑或 Docker，数据库会自动重新启动
    restart: always
  
    # 环境变量：设置初始的 root 用户账号密码
    # ⚠️ 必须与 .env 文件中的 DB_USER / DB_PASS 保持一致
    environment:
      MONGO_INITDB_ROOT_USERNAME: root
      MONGO_INITDB_ROOT_PASSWORD: 123456
  
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

```

## 6. 数据管理与注意事项

### 6.1 数据在哪里？

由于配置了 `volumes`，你的所有数据库数据（集合、文档）实际上都存储在项目根目录的 **`mongo-data/`** 文件夹中。

- **优势**: 即使你删除了 Docker 容器 (`down`)，只要这个文件夹还在，你的数据就在。

### 6.2 Git 忽略 (重要)

这个文件夹包含大量的二进制文件，**绝对不能**提交到 Git。

检查 `.gitignore` 文件确保包含：

```gitignore
# 忽略数据库数据目录
mongo-data/
```
