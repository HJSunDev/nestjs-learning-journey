# 010. 全局配置管理 (Config) 最佳实践

## 1. 行动导向 (Action Guide)

**(类型 A: 环境搭建) -> 集成高级配置管理**

- [Step 1] **安装依赖**:

  ```bash
  npm install @nestjs/config joi
  ```
- [Step 2] **配置环境变量**:
  修改 `.env` 文件（注意：变量名需与 Validation 和 Load 逻辑对应）：

  ```env
  APP_ENV=development
  APP_PORT=3000
  DB_URL=mongodb://mongo:27017
  DB_NAME=nest_journey
  DB_USER=root
  DB_PASS=123456
  DB_ENTITY_NAME=mongo
  DB_SYNCHRONIZE=false
  DB_LOGGING=true
  ```
- [Step 3] **实现 AppConfigModule**:
  创建 `src/common/configs/app-config.module.ts`，实现 Validation + Load 双重逻辑：

  ```typescript
  import { Module } from '@nestjs/common';
  import { ConfigModule } from '@nestjs/config';
  import * as Joi from 'joi';

  @Module({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        envFilePath: '.env',
        // 1. 强校验：确保 .env 文件中必须存在某些变量，且格式正确
        validationSchema: Joi.object({
          APP_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
          APP_PORT: Joi.number().default(3000),
          DB_URL: Joi.string().required(),
          DB_NAME: Joi.string().required(),
          DB_USER: Joi.string().required(),
          DB_PASS: Joi.string().required(),
          DB_SYNCHRONIZE: Joi.boolean().default(false),
          DB_LOGGING: Joi.boolean().default(false),
        }),
        // 2. 结构化与类型转换：将扁平的 env 字符串转换为结构化对象
        load: [() => ({
          env: process.env.APP_ENV,
          port: parseInt(process.env.APP_PORT || '3000', 10),
          database: {
            url: process.env.DB_URL,
            name: process.env.DB_NAME,
            user: process.env.DB_USER,
            pass: process.env.DB_PASS,
            synchronize: process.env.DB_SYNCHRONIZE === 'true', // 类型转换 String -> Boolean
            logging: process.env.DB_LOGGING === 'true',
          },
        })],
      }),
    ],
    exports: [ConfigModule],
  })
  export class AppConfigModule {}
  ```
- [Step 4] **全局注册**:
  在 `AppModule` 中导入 `AppConfigModule`：

  ```typescript
  import { Module } from '@nestjs/common';
  import { AppConfigModule } from './common/configs/app-config.module';

  @Module({
    imports: [
      AppConfigModule, // 注册配置模块
      // ... 其他模块
    ],
    // ...
  })
  export class AppModule {}
  ```
- [Step 5] **业务代码**:

  **示例 1：在 main.ts 中使用端口**

  ```typescript
  // src/main.ts
  import { ConfigService } from '@nestjs/config';
  // ...
  const configService = app.get(ConfigService);
  const port = configService.get<number>('port') ?? 3000;
  await app.listen(port);
  ```

  **示例 2：在 Service 中获取数据库 URL**

  ```typescript
  // src/user/user.service.ts
  constructor(private readonly configService: ConfigService) {}

  async method() {
    const dbUrl = this.configService.get<string>('database.url');
  }
  ```

---

## 2. 核心问题与概念 (The "Why")

- **解决什么问题**:

  - **环境隔离**: 开发环境连 `localhost` 数据库，生产环境连 `AWS RDS`。如果不把配置抽离出代码，发布时就得手动改代码，极易出错。
  - **安全性**: 像 `API_KEY`、数据库密码这种敏感信息，绝对不能提交到 Git 仓库里。
  - **类型安全**: `process.env.PORT` 拿出来的是字符串，还可能是 `undefined`。直接用它写代码很不安全。
- **核心概念**:

  - **.env 文件**: 事实上的工业标准。简单的 `KEY=VALUE` 文本文件，通常被 Git 忽略。
  - **ConfigModule**: NestJS 官方提供的配置加载器，负责读取 `.env` 并注入到应用中。
  - **Joi Validation**: 负责启动时的校验，确保必要的环境变量存在且格式正确。
  - **Load Factory**: 负责将扁平的环境变量转换为结构化、有类型的配置对象，供业务代码使用。

---

## 3. 深度原理与机制 (Under the Hood)

### 3.1 混合配置模式 (Validation + Load)

我们采用 **Validation (校验)** 与 **Load (加载)** 相结合的混合模式，兼顾安全与易用性。

**处理流程**:

1. **读取 (Read)**: 从 `.env` 文件读取原始环境变量。
2. **校验 (Validate - Joi)**:
   * **先行执行**：在应用启动的最早期阶段执行。
   * **职责**：只负责检查“变量是否存在”以及“原始格式是否正确”（如是否为数字字符串）。
   * **效果**：如果校验失败（如缺少 `DB_URL`），应用直接报错退出 (Fail Fast)，避免带病运行。
3. **加载 (Load - Factory)**:
   * **后置执行**：只有当 Validation 通过后才会执行。
   * **职责**：负责将扁平的 `process.env` 转换为**结构化**（嵌套对象）且**强类型**（Number, Boolean）的数据。
   * **效果**：业务代码通过结构化路径（如 `database.url`）获取配置，无需再次进行类型转换。

### 3.2 全局模块机制 (`isGlobal: true`)

`AppConfigModule` 被配置为全局模块，这意味一旦在 `AppModule` 中导入，所有其他模块（如 `UserModule`）都可以直接注入 `ConfigService`，无需重复导入。

---

## 4. 最佳实践 (Best Practices)

- ✅ **Fail Fast (快速失败)**: 利用 Joi 校验确保缺失配置时应用无法启动。
- ✅ **Config Object Pattern**: 使用 `load` 函数将配置组织成对象，而不是散落的 Key-Value。
- ✅ **类型转换前置**: 在配置模块层就把 `'true'` 转为 `true`，把 `'3000'` 转为 `3000`，业务逻辑层只管用。
- ✅ **单一数据源**: 代码中除了 `AppConfigModule`，其他地方严禁出现 `process.env`。
