# 030. 从 MongoDB 迁移到 PostgreSQL 

## 1. 深度解析与选型思考

### 1.1 MongoDB：灵活的文档存储

- **本质**: 它是基于 **BSON (Binary JSON)** 的 NoSQL 文档型数据库。它没有预定义的 Schema（模式），数据以“文档”的形式存储在“集合”中。
- **核心优势**:
  - **Schema-less**: 极度灵活，适合字段迭代频繁的初期项目或非结构化数据（如日志、爬虫数据）。
  - **Horizontal Scaling**: 原生支持分片（Sharding），适合海量数据的水平扩展。
- **适用场景**: 内容管理系统 (CMS)、实时分析日志、用户画像等数据结构不固定的场景。

### 1.2 PostgreSQL：先进的对象关系型数据库 (ORDBMS)

- **本质**: 它是世界上最先进的开源 **对象-关系型数据库**。它不仅支持标准的 SQL，还支持复杂的对象定义。
- **为什么选择 PG (vs MySQL)**:
  - **JSONB 支持**: PG 的 JSONB 类型支持二进制存储和 GIN 索引，查询性能远超 MySQL 的 JSON 类型，这使得 PG 兼具了 SQL 的严谨和 NoSQL 的灵活。
  - **数据类型丰富**: 原生支持 UUID、数组、网络地址、几何数据 (PostGIS)，适合复杂业务建模。
  - **严格的 SQL 标准**: 对事务隔离级别和约束的支持更加严谨，适合金融级或高一致性要求的业务。
- **适用场景**: 复杂企业级应用、地理信息系统 (GIS)、混合了结构化与非结构化数据（需要 JSON 查询）的场景。

### 1.3 核心维度对比：Mongo vs MySQL vs PostgreSQL

| 核心关注点         | MongoDB                                                                                   | MySQL                                                                | PostgreSQL                                                                               |
| :----------------- | :---------------------------------------------------------------------------------------- | :------------------------------------------------------------------- | :--------------------------------------------------------------------------------------- |
| **数据模型** | **文档 (Document)**`<br>`数据以 JSON/BSON 嵌套存储，无强制外键。                  | **关系 (Relational)**`<br>`严格的表结构，行存储，强 Schema。 | **对象-关系 (ORDBMS)**`<br>`兼容关系型与对象特性，支持 JSONB、数组等复杂类型。   |
| **事务支持** | **有限支持**`<br>`虽然 4.0+ 支持多文档事务，但性能开销大，非强项。                | **成熟稳定**`<br>`InnoDB 引擎提供标准的 ACID 事务。          | **极致严谨**`<br>`支持 SSI 隔离级别，对复杂事务的处理更加健壮。                  |
| **查询能力** | **聚合管道 (Pipeline)**`<br>`适合处理嵌套文档，但对多表 JOIN 支持较弱 ($lookup)。 | **标准 SQL**`<br>`适合常规业务查询，JOIN 性能优秀。          | **SQL + NoSQL**`<br>`既支持复杂 JOIN，又能高效查询 JSON 内部字段 (JSONB Index)。 |

---

## 2. 行动指南 (Action Guide)

### Phase 1: 基础设施层 (Infrastructure)

**目标**: 替换底层存储引擎，确保新的数据库服务可用。

#### 1. Docker Compose 配置 (`docker-compose.yml`)

*完整可用的 PostgreSQL 16 容器配置。*

```yaml
version: '3.8'
services:
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
```

#### 2. 依赖变更 (`package.json`)

*移除 MongoDB 驱动，引入 PostgreSQL 驱动及 UUID 支持。*

```bash
# 1. 卸载旧依赖
npm uninstall mongodb

# 2. 安装新依赖
# pg: PostgreSQL 官方驱动
# uuid: 用于生成和校验 UUID (替代 ObjectId)
npm install pg uuid

# 3. 安装类型定义
npm install -D @types/uuid
```

---

### Phase 2: 配置与连接层 (Configuration)

**目标**: 调整 NestJS 的配置模块以适配 PostgreSQL 的连接参数。

#### 1. 环境变量模板 (`env.ai` / `.env`)

*注意端口和配置项的变更。*

```properties
APP_ENV=development
APP_PORT=3000

# === 数据库配置 (PostgreSQL) ===
# 基础连接信息
DB_HOST=localhost
DB_PORT=5432
DB_NAME=nest_journey

# 认证信息
# 在生产环境中，这些通常通过 CI/CD 变量注入，而不是写在文件里
DB_USER=postgres
DB_PASS=123456

# TypeORM 行为配置
DB_SYNCHRONIZE=true
DB_LOGGING=true

# === Redis 配置 ===
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=123456
REDIS_DB=0

# === 日志配置 ===
# 日志级别: error, warn, info, http, verbose, debug, silly
LOG_LEVEL=info
# 是否在控制台输出日志 (生产环境关闭)
LOG_ON_CONSOLE=true

# === 文件上传配置 ===
# 上传文件存储目录 (绝对路径或相对路径)
# 生产环境建议指定绝对路径 (如 /var/www/uploads)
# 开发环境可留空，默认为项目根目录下的 static/upload
UPLOAD_DIR=static/upload

# === JWT 配置 ===
JWT_ACCESS_SECRET=accessSecretKey
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_SECRET=refreshSecretKey
JWT_REFRESH_EXPIRES_IN=7d

```

#### 2. TypeORM 异步配置 (`app.module.ts`)

*这是连接数据库的核心入口。*

```typescript
    // 数据库连接配置 (PostgreSQL)
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      // useFactory 返回的这个对象，就是 TypeORM 的标准 DataSourceOptions 接口
      // NestJS 会将此对象直接透传给 TypeORM 核心库，用于建立数据库连接 (相当于 new DataSource(options))
      useFactory: (configService: ConfigService) => {
        const dbConfig = configService.get('database');
        return {
          type: 'postgres',
          host: dbConfig.host,
          port: dbConfig.port,
          username: dbConfig.user,
          password: dbConfig.pass,
          database: dbConfig.name,
          autoLoadEntities: true, // 自动加载通过 forFeature 注册的实体，无需手动配置 entities 路径
          synchronize: dbConfig.synchronize, // 是否自动同步数据库结构 (开发环境建议开启，生产环境建议关闭)
          // 生产环境强制仅记录错误，开发环境依据配置决定（通常开启以调试 SQL）
          logging: configService.get('env') === 'production' ? ['error', 'warn'] : dbConfig.logging, 
        };
      },
    }),
```

---

### Phase 3: 业务适配层 (Business Logic Adaptation)

**目标**: 将基于“文档”的业务逻辑转换为基于“关系”的逻辑。此处仅列出核心变更模式。

#### 1. Entity 变更模式：从 ObjectId 到 UUID

**为什么**: PostgreSQL 使用 UUID 作为分布式主键是最佳实践，它比自增 ID 更安全，比 ObjectId 更通用。

**变更前 (MongoDB)**:

```typescript
@ObjectIdColumn()
_id: ObjectId; // 依赖 MongoDB 特定类型
```

**变更后 (PostgreSQL) - `common.entity.ts`**:

```typescript
@PrimaryGeneratedColumn('uuid') // 使用标准 UUID 生成策略
id: string; // 标准字符串类型，对前端更友好

@CreateDateColumn({ type: 'timestamptz' }) // 带时区的时间戳
createdAt: Date;
```

#### 2. 关联关系变更：从手动引用到外键约束

**为什么**: MongoDB 通常存储 ID 字符串 (`roleId: string`)，数据一致性靠应用层保证。PostgreSQL 使用外键 (`Foreign Key`)，数据库层面强制保证引用的有效性，杜绝“孤儿数据”。

**变更示例 (`user.entity.ts`)**:

```typescript
@Entity('users')
export class User extends CommonEntity {
  // 建立真正的数据库级关联
  @ManyToOne(() => Role, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'role_id' }) // 指定数据库列名
  role?: Role;
}
```

#### 3. 复杂数据变更：从 BSON 到 JSONB

**为什么**: `jsonb` 是 PostgreSQL 的杀手级特性，它以二进制格式存储 JSON，支持索引。这让我们在享受关系型数据库严谨性的同时，保留了像 MongoDB 一样的灵活性（例如存储不确定的权限配置）。

**变更示例 (`role.entity.ts`)**:

```typescript
@Column({ type: 'jsonb', default: {} }) // 原生 JSONB 类型
permissions: Record<string, string[]>;
```

#### 4. Service 校验变更

**为什么**: `ObjectId` 有特定的格式校验逻辑，UUID 也有自己的校验逻辑。直接传入非法 ID 会导致数据库驱动报错，因此需要在 Service 层拦截。

**变更示例**:

```typescript
import { validate as isUUID } from 'uuid';

// 替换原有的 ObjectId.isValid(id)
if (!isUUID(id)) {
  throw new NotFoundException(`User with ID ${id} not found`);
}
```
