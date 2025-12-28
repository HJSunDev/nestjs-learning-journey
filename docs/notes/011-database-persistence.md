# 011. 数据持久化 (TypeORM + MongoDB)

## 1. 核心问题与概念 

### 1.1 依赖包功能解析

在开始之前，我们需要安装三个核心依赖，它们在架构中处于不同的层级：

- **`mongodb` (Driver / 驱动层)**:
  - 这是官方提供的 Node.js 驱动程序。
  - 它的职责是直接通过 TCP 协议与 MongoDB 数据库建立连接，执行底层的 BSON 数据序列化与网络通信。它是所有上层操作的基础。
- **`typeorm` (Core / 核心逻辑层)**:
  - 这是 ORM 框架的核心库，与具体框架（如 NestJS, Express）无关。
  - 它的职责是提供对象映射逻辑。它接收我们操作的 Entity 对象，将其属性变更转换为底层的数据库指令，然后调用驱动层执行。
- **`@nestjs/typeorm` (Integration / 框架集成层)**:
  - 这是 NestJS 官方提供的模块封装。
  - 它的职责是将 TypeORM 整合进 NestJS 的依赖注入（DI）体系。它提供了 `TypeOrmModule` 用于配置，以及 `@InjectRepository` 装饰器，使我们能够将 Repository 作为 Provider 注入到 Service 中。

### 1.2 核心模式：Repository 模式

**Repository (资源库)** 是 TypeORM 提供的核心设计模式，也是领域驱动设计 (DDD) 中的常见概念。

- **定义**: Repository 是一个介于**业务逻辑层 (Service)** 和 **数据映射层 (Data Mapper)** 之间的抽象层。
- **作用**: 它封装了对特定实体集合的所有数据访问操作（CRUD）。
- **优势**: 业务代码（Service）不再直接依赖底层的数据库查询语言（如 SQL 或 Mongo Query），而是调用语义化的方法（如 `save`, `find`）。这实现了业务逻辑与数据访问细节的解耦。

## 2. 核心用法 / 方案设计 (Usage / Design)

在 NestJS 中，我们几乎所有的数据库操作都是通过 **Repository** 完成的。以下按**真实业务场景**拆解核心用法。

### 场景 A: 新增数据 (Create & Save)

TypeORM 将新增操作分为两步：先在内存中“实例化”，再“持久化”到数据库。

```typescript
// 1. 准备数据 (Create)
// userRepository.create() 纯粹是内存操作，它将普通的 JSON 对象 (DTO) 
// 转换为 User 类的实例 (Entity)。此时数据库里还不存在这条数据。
const newUser = this.userRepository.create({
  name: 'John Doe',
  email: 'john@example.com'
});

// 2. 保存入库 (Save)
// save() 才是真正的数据库写操作。
// 它会返回保存后的完整对象（包含自动生成的 _id, createdAt 等字段）。
const savedUser = await this.userRepository.save(newUser);
```

### 场景 B: 查询数据 (Find)

查询是最常用的功能，Repository 提供了多种查找方式。

```typescript
// 1. 查列表 (Find All)
// 相当于 SQL 的 SELECT * 或 Mongo 的 db.users.find({})
const allUsers = await this.userRepository.find();

// 2. 带条件查询 (Find with Criteria)
// 查找 name 为 'John' 且 isActive 为 true 的用户
const activeJohns = await this.userRepository.find({
  where: { 
    name: 'John',
    isActive: true 
  },
  order: { createdAt: 'DESC' }, // 按创建时间倒序
  take: 10, // 限制返回 10 条 (Pagination)
});

// 3. 查单条 (Find One)
// findOneBy 用于根据简单条件查找一条记录。
// 注意：MongoDB 的 _id 必须封装为 ObjectId 对象才能匹配！
import { ObjectId } from 'mongodb';
const user = await this.userRepository.findOneBy({ 
  _id: new ObjectId('64f8a...') 
});
```

### 场景 C: 更新数据 (Save vs Update)

TypeORM 提供了两种更新思路，初学者容易混淆：

#### 方法 1：先查后改 (Save - 推荐用于复杂业务)

适合需要触发 `@BeforeUpdate` 钩子或需要在这个过程中做业务检查的场景。

```typescript
// 1. 先查出来
const user = await this.userRepository.findOneBy({ _id: ... });

// 2. 修改对象属性 (这是纯内存修改)
user.name = 'New Name';

// 3. 再次调用 save
// 智能判定：TypeORM 发现 user 对象里有 _id，就会自动执行 UPDATE 而不是 INSERT。
await this.userRepository.save(user); 
```

#### 方法 2：直接更新 (Update - 推荐用于简单高性能)

不把数据查出来，直接下达更新指令。

```typescript
// 直接告诉数据库：把 ID 为 xxx 的记录，name 字段改为 'New Name'
// update(条件, 要修改的字段部分)
const result = await this.userRepository.update(id, { name: 'New Name' });

// result.affected 代表受影响的行数。
// 如果为 0，说明没找到 ID，更新失败。
if (result.affected === 0) {
  throw new NotFoundException();
}
```

### 场景 D: 删除数据 (Delete)

同样是直接操作数据库，物理删除记录。

```typescript
// delete(条件)
const result = await this.userRepository.delete(id);

// 同样可以通过 affected 判断是否删除成功
if (result.affected === 0) {
  console.log('用户不存在，无需删除');
}
```

## 3. 深度原理与机制 (Under the Hood)

### 3.1 配置机制：为什么用 `forRootAsync`？

在 `AppModule` 中配置数据库时，我们选择了 `forRootAsync` 而不是 `forRoot`。

- **`forRoot` (同步)**: 模块初始化时立即需要配置。缺点是无法利用 NestJS 的依赖注入系统（例如无法注入 `ConfigService`）。
- **`forRootAsync` (异步)**:
  - **运行机制**: NestJS 会等待 `ConfigService` 初始化完成，将其**注入**到 `useFactory` 中。
  - **数据流**: `ConfigModule` -> `ConfigService` -> 读取 `.env` -> `TypeOrmModule`。
  - **优势**: 确保了数据库配置可以使用经过 Joi 校验和处理的环境变量。

### 3.2 多数据库支持 (Multi-Database Support)

在大型系统中，我们经常需要连接多个数据库。例如：**核心业务用 MySQL，日志/埋点用 MongoDB**。NestJS 官方模块通过“命名连接”完美支持这一场景。

以下是完整的实现流程：

#### 1. 配置两个连接 (AppModule)

在 `AppModule` 中调用两次 `forRoot` (或 `forRootAsync`)。其中一个必须有 `name` 属性，作为它的唯一标识。

```typescript
// src/app.module.ts
@Module({
  imports: [
    // 连接 1: 默认连接 (无 name) -> 连接 MySQL
    TypeOrmModule.forRoot({
      type: 'mysql',
      host: 'localhost',
      // ... 其他 MySQL 配置
    }),

    // 连接 2: 命名连接 (name: 'LOG_DB') -> 连接 MongoDB
    TypeOrmModule.forRoot({
      name: 'LOG_DB', // 👈 关键：给这个连接起个名字
      type: 'mongodb',
      host: 'localhost',
      // ... 其他 MongoDB 配置
    }),
  ],
})
export class AppModule {}
```

#### 2. 注册实体到指定连接 (Feature Module)

在模块中注册实体时，如果该实体属于辅数据库，需要指定连接名。

```typescript
// src/logs/logs.module.ts
@Module({
  imports: [
    // 将 Log 实体注册到 'LOG_DB' 连接
    TypeOrmModule.forFeature([Log], 'LOG_DB'), 
  
    // 如果是默认连接的实体，则不需要第二个参数
    // TypeOrmModule.forFeature([User]), 
  ],
  providers: [LogsService],
})
export class LogsModule {}
```

#### 3. 注入 Repository (Service)

在 Service 中注入时，同样需要指定连接名，告诉 NestJS 你想要哪个数据库的 Repository。

```typescript
// src/logs/logs.service.ts
@Injectable()
export class LogsService {
  constructor(
    // 注入辅数据库 (MongoDB) 的 Repository
    @InjectRepository(Log, 'LOG_DB')
    private logRepo: Repository<Log>,

    // 注入主数据库 (MySQL) 的 Repository (不需要名字)
    @InjectRepository(User)
    private userRepo: Repository<User>,
  ) {}

  async createLog(userId: number, action: string) {
    // 1. 从 MySQL 查用户
    const user = await this.userRepo.findOneBy({ id: userId });
  
    // 2. 往 MongoDB 写日志
    const log = this.logRepo.create({ 
      user: user.name, 
      action, 
      timestamp: new Date() 
    });
    return await this.logRepo.save(log);
  }
}
```

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

### 4.1 技术选型

- ✅ **推荐**: 使用 `@nestjs/typeorm` 官方模块。
  - **理由**: 配置简单（`forRoot`, `forFeature`），符合 NestJS 标准开发范式，享受官方维护的实体扫描和连接管理功能。
- ❌ **避免**: 手动创建 Provider 封装 TypeORM。
  - **理由**: 虽然灵活但配置繁琐，容易丢失框架提供的便利性。

### 4.2 MongoDB 特有注意事项

- **AuthSource**: 连接非 admin 数据库且开启认证时，必须在连接字符串或配置中指定 `authSource=admin`。
- **ObjectId**: TypeORM 的 `findOne` 等方法查询 ID 时，**必须**使用 `new ObjectId(id)` 包装，不能直接传字符串。
- **Synchronize**: `synchronize: true` 在 MongoDB 中主要用于索引创建，不会像 SQL 那样修改表结构（因为 Mongo 是 Schema-less 的）。生产环境建议关闭。
- **Update 返回值**: `update` 方法返回的是操作结果（影响行数），如果需要最新的数据对象，更新后通常需要重新 `findOne`。

## 5. 行动导向 (Action Guide)

本指南演示如何从零集成 TypeORM 并实现一个 User 模块的持久化层。

### Step 1: 安装依赖

**这一步在干什么**：下载必要的工具包。

- `mongodb` (驱动): 负责与数据库建立底层 TCP 连接和数据传输。
- `typeorm` (核心): 负责将对象操作翻译为数据库指令。
- `@nestjs/typeorm` (集成): 负责将 ORM 注入到 NestJS 的依赖注入系统中。

```bash
npm install @nestjs/typeorm typeorm mongodb
```

### Step 2: 配置数据库连接 (AppModule)

**这一步在干什么**：全剧配置。
我们需要在应用的**根模块** (`AppModule`) 中初始化数据库连接。这相当于初始化底层的 Socket 连接池。这里我们使用 `forRootAsync` 是为了能安全地从环境变量 (`.env`) 中读取数据库密码。

```typescript
// src/app.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
// ... 其他 import

@Module({
  imports: [
    AppConfigModule, // 全局配置模块，一旦导入，所有其他模块都能直接用 ConfigService
    // 数据库连接配置
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      // useFactory 返回的这个对象，就是 TypeORM 的标准 DataSourceOptions 接口
      // NestJS 会将此对象直接透传给 TypeORM 核心库，用于建立数据库连接 (相当于 new DataSource(options))
      useFactory: (configService: ConfigService) => {
        const dbConfig = configService.get('database');
        return {
          type: 'mongodb',
          host: dbConfig.host,
          port: dbConfig.port,
          username: dbConfig.user,
          password: dbConfig.pass,
          database: dbConfig.name,
          authSource: dbConfig.authSource, 
          autoLoadEntities: true, // 自动加载通过 forFeature 注册的实体，无需手动配置 entities 路径
          synchronize: dbConfig.synchronize, // MongoDB 只有在 v3 驱动下才完全支持 synchronize，通常生产环境建议设为 false
          logging: dbConfig.logging, // 是否打印数据库操作日志
          // useUnifiedTopology: true, // 已废弃：自 MongoDB Driver 4.0.0 起，useUnifiedTopology 选项已被移除且不再生效，配置会出现警告信息
        };
      },
    }),
    UserModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

### Step 3: 定义实体 (Entity)

**这一步在干什么**：定义数据模型。
数据库本身只存二进制或 JSON 数据，它不知道什么是 `User` 类。我们需要创建一个类，并用装饰器（`@Entity`, `@Column`）定义 Schema，告诉 TypeORM 如何将数据库文档映射为 TypeScript 对象。

```typescript
import { Entity, Column, ObjectIdColumn } from 'typeorm';

@Entity('users') // 指定 MongoDB 集合名
export class User {
  @ObjectIdColumn()
  _id: any; // 必须: MongoDB 的唯一标识

  @Column()
  name: string;

  @Column()
  email: string;

  // 更多字段...
}
```

### Step 4: 注册实体 (Feature Module)

**这一步在干什么**：构建 Repository Provider。
虽然我们在 Step 2 连接了数据库，但 NestJS 采用模块化设计。`UserModule` 默认是不包含 `User` 实体的 Repository 的。
我们需要通过 `forFeature` 显式注册，NestJS 会在底层创建一个 `Repository<User>` 实例，并将其注册为 Provider，使其可以被注入。

```typescript
// src/user/user.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.mongo.entity';
import { UserService } from './user.service';
import { UserController } from './user.controller';

@Module({
  imports: [
    // 👇 关键: 注册 User 实体
    TypeOrmModule.forFeature([User]), 
  ],
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}
```

### Step 5: 业务层使用 (Service)

**这一步在干什么**：依赖注入与调用。
前面的铺垫都是为了这一步。现在 Repository Provider 已经准备好了，我们通过构造函数注入，获取该 Repository 实例，然后调用其方法执行具体的业务逻辑。

```typescript
// src/user/user.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.mongo.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { ObjectId } from 'mongodb';

@Injectable()
export class UserService {
  constructor(
    // 👇 注入 Repository
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async create(createUserDto: CreateUserDto) {
    // 1. 创建内存对象
    const newUser = this.userRepository.create(createUserDto);
    // 2. 保存到数据库
    return await this.userRepository.save(newUser);
  }

  async findAll() {
    return await this.userRepository.find();
  }

  async findOne(id: string) {
    // 👇 注意: MongoDB ID 查询需转换
    const user = await this.userRepository.findOneBy({ _id: new ObjectId(id) });
    if (!user) throw new NotFoundException(`User #${id} not found`);
    return user;
  }
}
```
