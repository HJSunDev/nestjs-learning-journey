# 013. Winston 分级日志与日志轮转 (Advanced Logging)

## 1. 核心问题与概念 

- **解决什么问题**:

  - **持久化**: `console.log` 输出到标准输出流 (stdout)，一旦终端关闭或容器重启，日志即丢失。我们需要将日志持久化到文件或外部系统。
  - **可观测性**: 生产环境需要根据错误级别 (`error`, `warn`, `info`) 快速筛选问题，而不是面对海量的文本流。
  - **文件管理**: 单个日志文件如果无限增长会占满磁盘且难以打开。需要"日志轮转" (Log Rotation) 机制来自动切割、压缩和清理旧日志。
- **核心概念**:

  - **Transports (传输通道)**: Winston 的核心概念，决定日志"去哪里"。可以同时配置多个通道：一个去控制台，一个去文件，一个去数据库。
  - **Log Rotation (日志轮转)**: 一种文件管理策略。例如"每天生成一个新文件"或"文件超过 20MB 就切割"，并自动删除 N 天前的旧文件。
  - **Structured Logging (结构化日志)**: 将日志输出为 JSON 格式，包含时间戳、上下文、级别等字段，便于 ELK (Elasticsearch, Logstash, Kibana) 等工具解析和索引。

## 2. 核心用法 / 方案设计 (Usage / Design)

### 场景 A: 生产环境配置策略

我们采用了 **"分级存储 + 自动轮转"** 的策略：

1. **控制台 (Console)**: 开发环境开启，用于实时调试；生产环境可视情况关闭。
2. **错误日志 (Error Log)**: 只记录 `error` 级别。当系统报警时，只看这个文件，干扰最少。
3. **全量日志 (Combined Log)**: 记录 `info` 及以上所有级别。用于排查业务流程和回溯现场。

```typescript
// src/common/logger/logger.module.ts 核心配置片段

// 1. 错误日志通道：只存 error，按天切割，保留 14 天
new winston.transports.DailyRotateFile({
  level: 'error',
  dirname: 'logs',
  filename: 'error-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true, 
  maxFiles: '14d',
})

// 2. 组合日志通道：存 info 及以上
new winston.transports.DailyRotateFile({
  dirname: 'logs',
  filename: 'combined-%DATE%.log', 
  // ... 其他配置相同
})
```

### 场景 B: 在业务代码中使用

一旦在 `main.ts` 替换了全局 Logger，在任何 Service 或 Controller 中既可以使用标准的 `Logger` 类，也可以注入 `WINSTON_MODULE_PROVIDER`。

**推荐方式**: 直接使用 NestJS 原生 `Logger` (解耦，不依赖特定库)。

```typescript
import { Logger, Injectable } from '@nestjs/common';

@Injectable()
export class UserService {
  // 1. 初始化 Logger，传入上下文 'UserService'
  private readonly logger = new Logger(UserService.name);

  create(userDto: any) {
    // 2. 记录日志
    this.logger.log('开始创建用户...'); 
  
    try {
      // 业务逻辑...
      this.logger.debug(`用户数据: ${JSON.stringify(userDto)}`); // debug 级别
    } catch (error) {
      // 3. 记录错误，附带堆栈信息
      this.logger.error('创建用户失败', error.stack);
    }
  }
}
```

### 场景 C: 集成 TypeORM 日志 (Database Integration)

**问题背景**：TypeORM 默认使用 `console.log` 直接输出 SQL，完全绕过了我们的 Winston 日志系统。这导致：
- SQL 日志格式与业务日志不统一
- SQL 日志不会被写入 `logs/` 文件夹
- 无法通过 `LOG_LEVEL` 统一控制

**解决方案**：创建自定义 Logger 适配器，实现 TypeORM 的 `Logger` 接口，内部调用 NestJS 的 `Logger`（底层已被 Winston 接管）。

**核心设计 - 日志级别映射策略**：
| TypeORM 动作 | 映射级别 | 说明 |
| :--- | :--- | :--- |
| 普通查询 (`logQuery`) | `debug` | 生产环境 `LOG_LEVEL=info` 时自动屏蔽，排查时改为 `debug` 即可看到 |
| 慢查询 (`logQuerySlow`) | `warn` | 生产环境必须记录，用于性能分析 |
| 错误 (`logQueryError`) | `error` | 生产环境必须记录，用于故障追溯 |

**最佳实践收益**：
- **生产安静**：`LOG_LEVEL=info` 时，海量普通 SQL 被自动过滤。
- **排查灵活**：遇到 Bug 时，只需临时修改 `LOG_LEVEL=debug`（无需改代码），全量 SQL 立即浮现。
- **统一归档**：SQL 日志也会被 Winston 自动轮转和压缩到 `logs/` 目录。

## 3. 深度原理与机制 (Under the Hood)

- **Logger 替换机制**:
  NestJS 启动时有一个默认的 ConsoleLogger。当我们调用 `app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER))` 时，Nest 内部的日志接口 (`LoggerService`) 实现被替换成了 `nest-winston` 提供的适配器。
- **Buffer Logs (日志缓冲)**:
  在 `main.ts` 中 `NestFactory.create(AppModule, { bufferLogs: true })` 非常关键。

  - **问题**: 在 `app.useLogger()` 执行之前，Nest 核心模块（如 ModuleLoader）已经开始工作并产生日志。如果直接替换，这部分启动日志会使用默认 Logger 输出，格式不统一。
  - **解决**: `bufferLogs: true` 让 Nest 先把日志暂时"缓存"起来，等到我们配置好 Winston 并赋值给 `app` 后，再统一用 Winston 将缓存的日志输出来。
- **依赖注入与配置**:
  我们的 `LoggerModule` 使用了 `forRootAsync` 和 `inject: [ConfigService]`。这确保了日志配置（如日志级别、文件路径）不是写死的，而是可以在 `env` 文件中动态调整的。

- **日志级别过滤机制 (Level Filtering)**:
  Winston 的日志过滤像水流一样，有两道关卡：
  1.  **全局总闸 (Root Level)**: 在 `WinstonModule.forRoot` 的返回值中配置 (`level: 'info'`)。这是第一道防线，如果这里设为 `info`，那么 `debug` 级别的日志在这里就会被直接丢弃，根本不会流向任何 Transport。
  2.  **通道分闸 (Transport Level)**: 在 `new DailyRotateFile({ level: ... })` 中配置。只有通过了总闸的日志，才会到达这里进行二次筛选。
  
  > **关键点**: 如果你在配置文件中设置 `LOG_LEVEL=info`，那么即使你的代码里写了 `logger.debug(...)`，或者你的 Transport 没有设置级别限制，这条日志也永远不会被记录。

- **日志级别详解 (Log Levels)**:
  NestJS (默认使用 npm 级别标准) 的优先级从高到低如下（数值越小优先级越高）：
  
  | 级别 | 数值 | 场景说明 |
  | :--- | :--- | :--- |
  | **error** | 0 | **系统崩溃/功能失效**。需要立即介入处理的问题（如：数据库连接断开、未捕获的异常）。 |
  | **warn** | 1 | **潜在风险**。不影响当前运行但需要关注（如：使用了废弃 API、请求参数不规范但已自动修正）。 |
  | **info** | 2 | **正常流转**。关键业务节点的确认（如：应用启动成功、订单创建成功）。生产环境通常开到这一级。 |
  | **debug** | 4 | **调试信息**。开发调试用，记录数据流转细节（如：传入的参数对象、复杂的逻辑分支走向）。 |
  | **verbose** | 5 | **冗余信息**。比 debug 更细碎的信息。 |
  
  > **过滤规则**: 设置级别为 `info` (2) 时，系统会记录 `error`(0), `warn`(1), `info`(2) 的日志，而忽略 `debug`(4) 及之后的日志。

### Q&A: 为什么既要在 AppModule 导入，又要在 main.ts 替换？

这是一个常见疑问，两者其实是**因果关系**，缺一不可：

1.  **AppModule 导入 (负责"生产")**: 
    - 作用：将 `LoggerModule` 放入 NestJS 的依赖注入容器。如果不导入，Winston 的实例根本不会被创建。
    - 比喻：**"招聘入职"**。把 Winston 招进公司，让他待命。

2.  **main.ts 替换 (负责"任命")**:
    - 作用：告诉 NestJS 框架，"请把你的御用 Logger 换成容器里这个 Winston 实例"。

> **思考**: 必须替换全局 Logger 吗？
> 
> 不一定。如果不执行 `app.useLogger()`，Winston 依然存在于容器中。你依然可以在 Service 中通过 `@Inject(WINSTON_MODULE_PROVIDER)` 来使用它。
> 但替换的好处是**全托管**：NestJS 内部的系统日志、报错日志，以及你代码里习惯用的 `new Logger()` 都会自动统一使用 Winston，实现真正的**无感替换**和**统一治理**。

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

- ✅ **敏感信息脱敏**: 严禁在日志中直接打印密码、Token、PII (个人隐私信息)。
- ✅ **使用 JSON 格式**: 生产环境文件日志务必使用 `winston.format.json()`，方便机器解析。
- ✅ **Request ID 追踪**: 结合 Middleware 或 Interceptor，为每个请求生成唯一的 `traceId` 并附加到该请求的所有日志中（高级进阶）。
- ❌ **避免 `console.log`**: 既然上了 Winston，就全局搜索并移除代码里所有的 `console.log`，它们无法被日志系统管控。
- ❌ **同步写入**: 默认 Winston 是异步写入文件，不要强行改为同步，否则会阻塞 Event Loop 导致接口卡顿。

## 5. 行动导向 (Action Guide)

### Step 1: 安装与目录准备

**这一步在干什么**: 安装 Winston 核心库、NestJS 适配器以及文件轮转插件。

```bash
npm install nest-winston winston winston-daily-rotate-file
```

### Step 2: 封装 LoggerModule

**这一步在干什么**: 创建一个独立的模块来配置 Winston，实现"开发环境看控制台，生产环境看文件"的策略。
*(参考 `src/common/logger/logger.module.ts` 的完整实现)*

### Step 3: 接管全局日志

**这一步在干什么**: 在应用启动的最早阶段替换 Logger，确保全生命周期日志统一。

```typescript
// src/main.ts
async function bootstrap() {
  // 1. 开启 bufferLogs，暂存启动日志
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true, 
  });

  // 2. 替换为 Winston Logger
  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));
  
  // ... 其他逻辑
}
```

### Step 4: 集成 TypeORM 日志

**这一步在干什么**: 创建适配器类，将数据库 SQL 日志桥接到 Winston 系统，实现统一管理。

**4.1 新建适配器文件**: `src/common/logger/typeorm-logger.ts`

```typescript
import { Logger as NestLogger } from '@nestjs/common';
import { Logger as ITypeOrmLogger, QueryRunner } from 'typeorm';

/**
 * 自定义 TypeORM 日志适配器
 * 
 * 作用：将 TypeORM 的原生日志（直接 console.log）桥接到 NestJS 的统一 Logger 系统中。
 * 优势：
 * 1. 统一格式：SQL 日志也遵循 JSON/Winston 格式
 * 2. 统一存储：SQL 日志会自动进入 logs/ 文件夹
 * 3. 灵活级别：普通 SQL 使用 debug 级别，生产环境可以通过调整全局 LOG_LEVEL 来决定是否记录
 */
export class TypeOrmLogger implements ITypeOrmLogger {
  // 使用 NestJS 的 Logger，上下文命名为 'TypeORM'
  private readonly logger = new NestLogger('TypeORM');

  /**
   * 记录普通查询
   * 映射级别: debug (开发环境可见，生产环境通常 info 级别不可见)
   */
  logQuery(query: string, parameters?: any[], queryRunner?: QueryRunner) {
    const params = parameters && parameters.length ? ` -- PARAMETERS: ${JSON.stringify(parameters)}` : '';
    this.logger.debug(`${query}${params}`);
  }

  /**
   * 记录执行失败的查询
   * 映射级别: error
   */
  logQueryError(error: string | Error, query: string, parameters?: any[], queryRunner?: QueryRunner) {
    const params = parameters && parameters.length ? ` -- PARAMETERS: ${JSON.stringify(parameters)}` : '';
    this.logger.error(`${query}${params} -- ERROR: ${error}`);
  }

  /**
   * 记录执行缓慢的查询
   * 映射级别: warn
   */
  logQuerySlow(time: number, query: string, parameters?: any[], queryRunner?: QueryRunner) {
    const params = parameters && parameters.length ? ` -- PARAMETERS: ${JSON.stringify(parameters)}` : '';
    this.logger.warn(`Time: ${time}ms -- ${query}${params}`);
  }

  /**
   * 记录 Schema 构建/迁移日志
   * 映射级别: log (info)
   */
  logSchemaBuild(message: string, queryRunner?: QueryRunner) {
    this.logger.log(message);
  }

  /**
   * 记录迁移运行日志
   * 映射级别: log (info)
   */
  logMigration(message: string, queryRunner?: QueryRunner) {
    this.logger.log(message);
  }

  /**
   * 记录普通日志
   * 映射级别: log (info)
   */
  log(level: 'log' | 'info' | 'warn', message: any, queryRunner?: QueryRunner) {
    switch (level) {
      case 'log':
      case 'info':
        this.logger.log(message);
        break;
      case 'warn':
        this.logger.warn(message);
        break;
    }
  }
}
```

**4.2 配置 AppModule**: 在 `TypeOrmModule.forRootAsync` 中应用适配器

```typescript
// src/app.module.ts
import { TypeOrmLogger } from './common/logger/typeorm-logger';

@Module({
  imports: [
    // ...
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const dbConfig = configService.get('database');
        return {
          type: 'postgres',
          // ... 其他数据库连接配置
          
          // 使用自定义 Logger 接管 TypeORM 日志
          logger: new TypeOrmLogger(),
          // 策略控制：
          // 1. 如果 env 中 DB_LOGGING=true，则记录所有操作('all')。
          //    注意：此时具体是否打印，还取决于全局 LOG_LEVEL。
          //    例如 SQL 是 debug 级别，如果 LOG_LEVEL=info，则依然看不见 SQL。
          // 2. 如果 env 中 DB_LOGGING=false，则仅记录错误和警告(['error', 'warn'])。
          logging: dbConfig.logging ? 'all' : ['error', 'warn'],
        };
      },
    }),
  ],
})
export class AppModule {}
```
