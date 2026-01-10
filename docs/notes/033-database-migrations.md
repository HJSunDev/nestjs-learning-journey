# 033. 数据库迁移系统 (TypeORM Migrations)

## 1. 核心问题与概念

### 解决什么问题

在生产环境中，数据库结构的变更是一个高风险操作。TypeORM 提供的 `synchronize: true` 虽然方便开发，但存在致命缺陷：

**`synchronize: true` 的工作原理：**
当应用启动时，TypeORM 会对比 **Entity 代码** 和 **数据库表结构**。如果发现不一致，它会**暴力修改数据库**使其符合代码定义。

**为什么这是危险的？**

假设 User 表有一个 `name` 字段，存储了 10 万条用户真实姓名。某天你将其重命名为 `fullName`：

```typescript
// 修改前
@Column()
name: string;

// 修改后
@Column()
fullName: string;
```

如果开启了 `synchronize: true` 并重启应用，TypeORM 会：

1. 发现数据库里有 `name`，但代码里没有 → **删除 `name` 列（10 万条数据瞬间消失）**
2. 发现代码里有 `fullName`，但数据库里没有 → **创建新的空 `fullName` 列**

**后果：** 用户数据永久丢失，无法恢复。

### 核心概念

**Migration (迁移)** 是数据库结构的版本控制系统。它不再让程序启动时自动修改表结构，而是通过生成具体的 **迁移文件** 来描述每一次变更。

每个 Migration 文件包含两个核心方法：

- `up()` - 升级：描述如何执行变更（如 `CREATE TABLE...`）
- `down()` - 回滚：描述如何撤销变更（如 `DROP TABLE...`）

**关键优势：**

- **可追溯**：每次变更都有记录，可以通过 Git 追踪历史
- **可审查**：生成的 SQL 需要人工审查后再执行
- **可回滚**：任何变更都可以通过 `down()` 撤销
- **可复现**：同样的迁移文件在任何环境执行结果一致


TypeORM CLI 是一个**独立工具**，无法直接读取 NestJS 的 `AppModule` 配置。因此需要创建单独的 `data-source.ts` 配置文件。

### synchronize 的"双轨制"配置

项目中存在**两个完全独立的启动入口**，它们各自有独立的配置：

| 入口              | 启动命令                  | 配置来源                  | synchronize 读取位置        |
| ----------------- | ------------------------- | ------------------------- | --------------------------- |
| NestJS 应用服务器 | `npm run dev`           | `AppModule` → `.env` | `DB_SYNCHRONIZE` 环境变量 |
| TypeORM CLI 工具  | `npm run migration:run` | `data-source.ts`        | 代码中硬编码为 `false`    |

**为什么 CLI 配置中要硬编码 `synchronize: false`？**

CLI 的目的是**生成和运行迁移文件**。如果在 CLI 运行过程中又去搞"自动同步"，逻辑就会冲突（是要运行迁移文件，还是要暴力同步？）。为了安全起见，CLI 专用配置中**强制关闭**自动同步，确保它只听从 Migration 文件的指挥。

**关键提醒**：两边的配置互不干扰，但为了生产安全，**必须同时关闭两边的 synchronize**。

---

## 2. 核心用法 / 方案设计 (Usage / Design)

### 场景 A: 自动生成迁移（推荐）

当你修改了 Entity 定义后，TypeORM 可以自动对比代码与数据库的差异，生成迁移文件：

```bash
npm run migration:generate
```

**工作流程：**

1. 编译项目（`npm run build`）
2. 连接数据库，读取当前表结构
3. 扫描所有 Entity 定义
4. 对比差异，生成 SQL 迁移文件

**生成的文件示例：**

```typescript
export class Migration1768063048750 implements MigrationInterface {
  name = 'Migration1768063048750';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD "age" integer`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "age"`);
  }
}
```

### 场景 B: 手动创建迁移

某些复杂操作无法自动生成（如数据迁移、字段重命名），需要手动编写：

```bash
npm run migration:create
```

这会创建一个空的迁移模板，你需要手动填写 `up()` 和 `down()` 的 SQL：

```typescript
public async up(queryRunner: QueryRunner): Promise<void> {
  // 1. 添加新列
  await queryRunner.query(`ALTER TABLE "users" ADD "fullName" varchar`);
  // 2. 复制旧数据
  await queryRunner.query(`UPDATE "users" SET "fullName" = "name"`);
  // 3. 删除旧列
  await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "name"`);
}
```

### 场景 C: 执行迁移

在开发环境或生产部署时，执行所有待处理的迁移：

```bash
npm run migration:run
```

**输出示例：**

```
0 migrations are already loaded in the database.
1 migrations were found in the source code.
1 migrations are new migrations must be executed.
Migration Migration1768063048750 has been executed successfully.
```

### 场景 D: 回滚迁移

如果发现迁移有问题，可以回滚到上一个版本：

```bash
npm run migration:revert
```

这会执行最近一次迁移的 `down()` 方法。

### 场景 E: 查看迁移状态

查看所有迁移及其执行状态：

```bash
npm run migration:show
```

**输出示例：**

```
[X] 1768063048750-InitialSchema   # [X] 表示已执行
[ ] 1768063100000-AddAgeColumn    # [ ] 表示待执行
```

---

## 3. 深度原理与机制 (Under the Hood)

### 迁移系统的工作机制

```
┌──────────────────────────────────────────────────────────────┐
│                      Migration 生命周期                       │
└──────────────────────────────────────────────────────────────┘

1. 生成阶段 (Generate)
   ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
   │   Entity    │ ──▶  │   TypeORM   │ ──▶  │  Migration  │
   │   定义      │      │   Schema    │      │    文件     │
   │  (代码)     │      │   Differ    │      │   (SQL)     │
   └─────────────┘      └─────────────┘      └─────────────┘
         ▲                    │
         │                    ▼
   ┌─────────────┐      ┌─────────────┐
   │  Database   │ ◀─── │   Query     │
   │   Schema    │      │  Metadata   │
   └─────────────┘      └─────────────┘

2. 执行阶段 (Run)
   ┌─────────────┐      ┌─────────────┐      ┌─────────────┐
   │ migrations  │      │ 待执行迁移  │      │   执行      │
   │   表        │ ──▶  │  过滤器     │ ──▶  │  up()       │
   │ (已执行)    │      │             │      │             │
   └─────────────┘      └─────────────┘      └─────────────┘
```

**关键表：`migrations`**

TypeORM 会在数据库中创建一个 `migrations` 表来追踪迁移历史：

| id | timestamp     | name                   |
| -- | ------------- | ---------------------- |
| 1  | 1768063048750 | Migration1768063048750 |

当执行 `migration:run` 时：

1. 扫描所有迁移文件
2. 查询 `migrations` 表，获取已执行的迁移
3. 过滤出未执行的迁移
4. 按时间戳顺序执行 `up()` 方法
5. 将执行结果记录到 `migrations` 表

### TypeORM CLI 配置文件解析

```typescript
// src/database/data-source.ts
import 'dotenv/config';  // 直接加载 .env 文件
import { DataSource } from 'typeorm';

export const AppDataSource = new DataSource({
  type: 'postgres',
  // ... 连接配置

  // 实体路径：指向编译后的 JS 文件
  entities: ['dist/src/**/*.entity.js'],

  // 迁移文件路径
  migrations: ['dist/src/database/migrations/*.js'],

  // 关键：禁用自动同步
  synchronize: false,
});
```

**谁在使用 `AppDataSource`？**

你不会在代码中直接 import 它，因为它不是给 NestJS 应用用的，而是专门给 **TypeORM CLI** 用的。

请看 `package.json` 中的脚本：

```json
"typeorm": "npm run build && npx typeorm -d dist/src/database/data-source.js"
```

`-d` 参数（DataSource）明确告诉 CLI："请读取这个文件，使用其中导出的 `AppDataSource` 对象来连接数据库"。

**为什么使用 `dist/` 路径？**

TypeORM CLI 运行时使用的是编译后的 JavaScript 文件，而不是 TypeScript 源码。因此：

- `entities` 必须指向 `dist/` 目录下的 `.js` 文件
- `migrations` 同样指向编译后的迁移文件

---

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

### ✅ 推荐做法

1. **开发环境也使用迁移**：从项目开始就使用迁移，而不是等到上线前才切换
2. **人工审查迁移文件**：自动生成的 SQL 可能不是最优解，需要人工检查
3. **迁移文件提交到 Git**：迁移文件是代码的一部分，必须纳入版本控制
4. **先 build 再 migrate**：确保迁移基于最新的编译结果
5. **生产部署自动迁移**：在 CI/CD 流程中加入 `npm run migration:run`

### ❌ 避免做法

1. **生产环境使用 `synchronize: true`**：这是最危险的反模式
2. **修改已执行的迁移文件**：一旦迁移执行过，就不应该再修改
3. **手动修改 `migrations` 表**：除非你非常清楚自己在做什么
4. **跳过迁移直接修改数据库**：这会导致迁移系统与实际结构不一致

### ⚠️ 常见陷阱

**陷阱 1：字段重命名被识别为删除+新增**

```typescript
// 代码修改
- name: string;
+ fullName: string;
```

TypeORM 会生成：

```sql
ALTER TABLE "users" DROP COLUMN "name";
ALTER TABLE "users" ADD "fullName" varchar;
```

**解决方案**：手动编写迁移，使用 `RENAME COLUMN`：

```sql
ALTER TABLE "users" RENAME COLUMN "name" TO "fullName";
```

**陷阱 2：NestJS 编译输出路径**

NestJS 默认将文件编译到 `dist/src/` 而不是 `dist/`，需要注意路径配置。

**陷阱 3：PostgreSQL UUID 扩展缺失**

如果你的 Entity 使用了 UUID 主键：

```typescript
@PrimaryGeneratedColumn('uuid')
id: string;
```

TypeORM 生成的迁移会依赖 `uuid_generate_v4()` 函数：

```sql
"id" uuid NOT NULL DEFAULT uuid_generate_v4()
```

这个函数属于 PostgreSQL 的 `uuid-ossp` 扩展，**默认未启用**。在全新数据库上运行迁移可能报错：

```
function uuid_generate_v4() does not exist
```

**解决方案**：在初始迁移的 `up()` 方法最开始添加：

```typescript
await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
```

这保证了无论在什么环境，迁移都能自动安装必要的扩展。

---

## 5. 行动导向 (Action Guide)

### Step 1: 安装依赖

**这一步在干什么**：安装 `dotenv` 包，使 TypeORM CLI 能够独立读取 `.env` 环境变量。

```bash
npm install dotenv --save
```

### Step 2: 创建目录结构

**这一步在干什么**：建立迁移系统的文件组织结构。`data-source.ts` 是 CLI 专用配置，`migrations/` 存放迁移文件。

```
src/
└── database/
    ├── data-source.ts      # TypeORM CLI 配置
    └── migrations/         # 迁移文件目录
        └── .gitkeep        # Git 占位文件
```

**为什么需要 `.gitkeep` 文件？**

Git 版本控制系统**默认不跟踪空文件夹**。如果 `migrations/` 目录是空的，提交代码到 GitHub 后，这个文件夹会消失。

当同事拉取代码或 CI/CD 自动部署时，因为没有这个文件夹，运行迁移命令可能会报错"目录不存在"。

放一个空的 `.gitkeep` 文件（名字是约定俗成的），Git 就会认为"这个文件夹里有东西"，从而保留目录结构。

### Step 3: 创建 TypeORM CLI 配置文件

**这一步在干什么**：为 TypeORM CLI 创建独立的数据源配置。因为 CLI 无法读取 NestJS 的 `AppModule`，需要单独配置数据库连接。

```typescript
// src/database/data-source.ts
import 'dotenv/config';
import { DataSource, DataSourceOptions } from 'typeorm';

const options: DataSourceOptions = {
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'nest_journey',

  // 实体路径：NestJS 编译输出到 dist/src/ 目录
  entities: ['dist/src/**/*.entity.js'],

  // 迁移文件路径
  migrations: ['dist/src/database/migrations/*.js'],

  // 禁用自动同步，使用迁移管理数据库结构
  synchronize: false,

  logging: process.env.DB_LOGGING === 'true',
};

export const AppDataSource = new DataSource(options);
```

### Step 4: 配置 NPM 脚本

**这一步在干什么**：在 `package.json` 中添加迁移相关的快捷命令，简化日常操作。

```json
{
  "scripts": {
    "typeorm": "npm run build && npx typeorm -d dist/src/database/data-source.js",
    "migration:generate": "npm run typeorm -- migration:generate src/database/migrations/Migration",
    "migration:create": "npx typeorm migration:create src/database/migrations/Migration",
    "migration:run": "npm run typeorm -- migration:run",
    "migration:revert": "npm run typeorm -- migration:revert",
    "migration:show": "npm run typeorm -- migration:show"
  }
}
```

**命令说明：**

| 命令                   | 用途                           |
| ---------------------- | ------------------------------ |
| `migration:generate` | 根据 Entity 变更自动生成迁移   |
| `migration:create`   | 创建空迁移模板（手动编写 SQL） |
| `migration:run`      | 执行所有待处理迁移             |
| `migration:revert`   | 回滚最近一次迁移               |
| `migration:show`     | 显示所有迁移及状态             |

### Step 5: 关闭 synchronize

**这一步在干什么**：禁用自动同步，改用迁移系统管理数据库结构。

```env
# .env
DB_SYNCHRONIZE=false
```

### Step 6: 生成并执行初始迁移

**这一步在干什么**：为现有数据库结构创建**基线迁移（Initial Schema）**，作为后续变更的起点。

```bash
# 如果数据库已有表，先清空（仅开发环境）
npm run typeorm -- schema:drop

# 生成完整的建表迁移
npm run migration:generate

# 执行迁移，创建表结构
npm run migration:run

# 验证迁移状态
npm run migration:show
# 输出: [X] Migration1768063048750
```

**InitialSchema 迁移文件的诞生过程：**

当你运行 `npm run migration:generate` 时：

1. TypeORM CLI 连接数据库，扫描当前表结构（空的）。
2. 扫描你的 Entity 定义（`User`、`Role` 等）。
3. 对比差异："要把数据库变成 Entity 描述的样子，需要执行哪些 SQL？"
4. 自动生成 `CREATE TABLE`、`ADD CONSTRAINT` 等 SQL 语句。
5. 将这些 SQL 封装进一个带时间戳的 TS 文件（如 `1768063048750-InitialSchema.ts`）。

**它的作用：** 这是你数据库结构的**快照**。以后任何人拿到代码，只要运行 `npm run migration:run`，就能在他们的电脑上还原出一模一样的数据库结构，无需手动建表。

**重要提示**：生成的初始迁移文件需要手动添加 UUID 扩展支持（见陷阱 3），确保在任何环境都能正常运行。

### Step 7: 日常开发流程

**这一步在干什么**：展示迁移驱动的开发工作流。

```bash
# 1. 修改 Entity（如添加 age 字段）

# 2. 生成迁移
npm run migration:generate

# 3. 审查生成的迁移文件

# 4. 执行迁移
npm run migration:run

# 5. 提交代码和迁移文件到 Git
git add src/database/migrations/*.ts
git commit -m "feat(user): add age field"
```
