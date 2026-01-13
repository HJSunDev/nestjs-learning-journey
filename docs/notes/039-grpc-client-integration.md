# 039. gRPC 客户端集成与微服务通信

## 1. 核心问题与概念

### 解决什么问题

在现代微服务架构中，NestJS 通常作为 BFF (Backend For Frontend) 层存在，需要与其他后端服务（如 Go、Java 编写的计算密集型服务）进行通信。传统的 HTTP/REST 通信存在以下局限：

| 问题                      | 影响                                  |
| ------------------------- | ------------------------------------- |
| **JSON 序列化开销** | 大数据量场景下性能损耗明显            |
| **缺乏类型契约**    | 接口变更容易导致运行时错误            |
| **无原生流式支持**  | 需要 WebSocket 等额外机制实现流式传输 |
| **HTTP 头部开销**   | 高频调用时累积开销不可忽视            |

**gRPC 的解决方案**：

- **Protobuf 二进制协议**：序列化效率比 JSON 高 3-10 倍
- **强类型契约**：`.proto` 文件作为接口契约，编译时检查
- **原生流式支持**：服务端流、客户端流、双向流
- **HTTP/2 多路复用**：连接复用，降低延迟

### 核心概念与依赖

```
┌─────────────────────────────────────────────────────────┐
│                    NestJS 应用                          │
│  ┌──────────────┐    ┌──────────────┐                  │
│  │ AiService    │───▶│ ComputeClient│                  │
│  │ (业务模块)   │    │ (gRPC 封装)  │                  │
│  └──────────────┘    └──────┬───────┘                  │
│                             │                           │
│  ┌──────────────────────────▼───────────────────────┐  │
│  │              @nestjs/microservices               │  │
│  │  (NestJS 官方微服务模块，提供 gRPC 传输层抽象)   │  │
│  └──────────────────────────┬───────────────────────┘  │
│                             │                           │
│  ┌──────────────────────────▼───────────────────────┐  │
│  │                @grpc/grpc-js                      │  │
│  │  (纯 JS 的 gRPC 实现，替代 C++ 绑定的 grpc)      │  │
│  └──────────────────────────┬───────────────────────┘  │
│                             │                           │
│  ┌──────────────────────────▼───────────────────────┐  │
│  │              @grpc/proto-loader                   │  │
│  │  (动态加载 .proto 文件，无需预编译)              │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                              │
                              │ gRPC over HTTP/2
                              ▼
┌─────────────────────────────────────────────────────────┐
│                   Go 计算服务                           │
│              (实现 ComputeService)                      │
└─────────────────────────────────────────────────────────┘
```

**依赖解析**：

| 包名                      | 角色         | 说明                                           |
| ------------------------- | ------------ | ---------------------------------------------- |
| `@nestjs/microservices` | 微服务抽象层 | 提供 `ClientGrpc`、`Transport.GRPC` 等 API |
| `@grpc/grpc-js`         | gRPC 运行时  | 纯 JS 实现，无需编译 C++ 依赖                  |
| `@grpc/proto-loader`    | Proto 加载器 | 运行时动态解析 `.proto` 文件                 |

---

## 2. 核心用法 / 方案设计 (Usage / Design)

### 场景 A: 同步调用 (Request-Response)

适用于：结果可在合理时间内返回的计算任务

```typescript
// 在业务 Service 中使用
import { ComputeServiceClient } from '../grpc';

@Injectable()
export class DataAnalysisService {
  constructor(private readonly computeClient: ComputeServiceClient) {}

  async analyzeData(data: string): Promise<AnalysisResult> {
    const response = await this.computeClient.calculate({
      taskId: uuid(),
      taskType: 'data_analysis',
      payload: JSON.stringify({ data }),
      metadata: { source: 'web' },
    });

    if (response.status === 'failed') {
      throw new BadRequestException(response.errorMessage);
    }

    return JSON.parse(response.result);
  }
}
```

### 场景 B: 流式响应 (Server Streaming)

适用于：AI 推理、大文件处理等需要分块返回的场景

```typescript
import { ComputeServiceClient } from '../grpc';

@Injectable()
export class AiInferenceService {
  constructor(private readonly computeClient: ComputeServiceClient) {}

  /**
   * 流式推理 - 返回 Observable 供 Controller 转换为 SSE
   */
  streamInference(prompt: string): Observable<string> {
    const request: CalculateRequest = {
      taskId: uuid(),
      taskType: 'ai_inference',
      payload: prompt,
    };

    return this.computeClient.streamCalculate(request).pipe(
      map((chunk) => chunk.chunk),
      // 可添加额外处理，如累积结果、格式转换等
    );
  }
}

// Controller 中转换为 SSE
@Sse('inference/stream')
streamInference(@Query('prompt') prompt: string): Observable<MessageEvent> {
  return this.aiService.streamInference(prompt).pipe(
    map((data) => ({ data })),
  );
}
```

### 场景 C: 健康检查集成

将 gRPC 服务可用性纳入 `/health` 端点：

```typescript
// health.controller.ts
import { GrpcComputeHealthIndicator } from '../../grpc/indicators';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private grpcCompute: GrpcComputeHealthIndicator,
  ) {}

  @Get()
  check() {
    return this.health.check([
      () => this.grpcCompute.isHealthy('grpc-compute'),
    ]);
  }
}
```

---

## 3. 深度原理与机制 (Under the Hood)

### gRPC 连接生命周期

```
┌─────────────────────────────────────────────────────────────────┐
│                       NestJS 启动流程                           │
├─────────────────────────────────────────────────────────────────┤
│  1. AppModule 加载                                              │
│     └─▶ GrpcModule.registerAsync() 执行                        │
│         └─▶ ClientsModule.registerAsync() 创建 ClientProxy     │
│                                                                 │
│  2. 依赖注入完成                                                │
│     └─▶ ComputeServiceClient 实例化                            │
│         └─▶ 注入 ClientGrpc (但尚未连接)                       │
│                                                                 │
│  3. onModuleInit 生命周期钩子                                   │
│     └─▶ client.getService<T>('ServiceName')                    │
│         └─▶ 解析 .proto 文件                                   │
│         └─▶ 建立 HTTP/2 连接 (延迟连接)                        │
│         └─▶ 返回服务代理对象                                   │
│                                                                 │
│  4. 首次调用时                                                  │
│     └─▶ 真正建立 TCP 连接                                      │
│     └─▶ 发送 gRPC 请求                                         │
└─────────────────────────────────────────────────────────────────┘
```

### Proto 加载机制

NestJS 使用 `@grpc/proto-loader` 在运行时动态加载 `.proto` 文件，无需预编译：

```typescript
// 内部实现原理
const packageDefinition = protoLoader.loadSync(protoPath, {
  keepCase: false,      // 字段名转为驼峰
  longs: String,        // int64 转字符串 (避免精度丢失)
  enums: String,        // 枚举使用名称
  defaults: true,       // 填充默认值
  oneofs: true,         // 支持 oneof 字段
});

const grpcObject = grpc.loadPackageDefinition(packageDefinition);
const service = grpcObject.compute.ComputeService;
```

### 连接保活机制

gRPC 使用 HTTP/2 Ping 帧实现连接保活：

```typescript
channelOptions: {
  // 每 10 秒发送一次保活探测
  'grpc.keepalive_time_ms': 10000,
  // 5 秒内无响应则认为连接断开
  'grpc.keepalive_timeout_ms': 5000,
  // 即使没有活动调用也发送保活
  'grpc.keepalive_permit_without_calls': 1,
}
```

---

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

### ✅ 推荐做法

1. **Proto 文件版本管理**

   - 将 `src/proto/` 目录纳入 Git 版本控制
   - 生产环境考虑独立 Proto 仓库，多服务共享
2. **客户端封装层**

   - 不直接暴露 `ClientGrpc`，封装为业务语义的 Client 类
   - 统一处理超时、重试、错误转换
3. **超时配置**

   - 同步调用设置合理超时（如 30s）
   - 健康检查使用短超时（如 5s）
4. **错误处理**

   - 将 gRPC 错误码转换为 HTTP 异常
   - 区分可重试错误（`UNAVAILABLE`）和不可重试错误（`INVALID_ARGUMENT`）

### ❌ 避免做法

1. **避免硬编码服务地址**

   ```typescript
   // ❌ 错误
   url: 'localhost:50051'

   // ✅ 正确
   url: config.get('grpc.compute.url')
   ```
2. **避免忽略 int64 精度问题**

   ```typescript
   // ❌ 可能导致精度丢失
   longs: Number

   // ✅ 转为字符串处理
   longs: String
   ```
3. **避免在 Controller 直接使用 ClientGrpc**

   - 违反分层原则
   - 难以统一错误处理和日志

---

## 5. 行动导向 (Action Guide)

### Step 1: 安装依赖

**这一步在干什么**: 安装 NestJS 微服务模块和 gRPC 运行时库。

```bash
npm install @nestjs/microservices @grpc/grpc-js @grpc/proto-loader
```

### Step 1.5: 配置 nest-cli.json 复制 Proto 文件

**这一步在干什么**: 配置 NestJS 编译器在构建时自动复制 `.proto` 文件到 `dist` 目录。

#### nest-cli.json 是什么？

`nest-cli.json` 是 NestJS CLI 的配置文件，控制项目的构建、生成和运行行为。它类似于 TypeScript 的 `tsconfig.json`，但专门针对 NestJS 项目。

#### 为什么需要 assets 配置？

默认情况下，`nest build` 只会编译 `.ts` 文件到 `dist` 目录。但 gRPC 需要在运行时加载 `.proto` 文件，而 `.proto` 不是 TypeScript 文件，不会被自动处理。

**问题场景**：

```
src/proto/compute.proto  →  (编译后)  →  dist/ 中没有 proto 文件！
                                         ↓
                            运行时报错: proto 文件不存在
```

**解决方案**：使用 `assets` 配置告诉 NestJS CLI 额外复制这些非 TS 文件。

#### 配置示例

```json
// nest-cli.json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "assets": [
      {
        "include": "**/*.proto",
        "watchAssets": true
      }
    ]
  }
}
```

#### 配置项解释

| 字段                      | 作用                                         |
| ------------------------- | -------------------------------------------- |
| `deleteOutDir`          | 每次构建前清空 `dist` 目录，避免旧文件残留 |
| `assets`                | 定义需要额外复制的非 TS 文件规则             |
| `include: "**/*.proto"` | 匹配 `src/` 下所有 `.proto` 文件（递归） |
| `watchAssets: true`     | 开发模式下监听这些文件变化，自动重新复制     |

#### 构建后的目录结构

```
dist/
├── proto/
│   └── compute/
│       └── compute.proto   ← 自动复制过来
└── src/
    └── ...                 ← 编译后的 JS 文件
```

### Step 2: 创建配置文件

**这一步在干什么**: 将 gRPC 连接参数外置到配置系统，支持多环境切换。

```typescript
// src/common/configs/config/grpc.config.ts
import { registerAs } from '@nestjs/config';
import { join, resolve, isAbsolute } from 'path';
import { existsSync } from 'fs';

export default registerAs('grpc', () => {
  // 使用显式配置优先，避免运行时"猜路径"造成排障困难
  const computeProtoOverride = process.env.GRPC_COMPUTE_PROTO_PATH?.trim();

  // 允许传入相对路径（从项目根目录解析），同时兼容绝对路径（容器/K8s 更常见）
  const overridePath =
    computeProtoOverride && computeProtoOverride.length > 0
      ? isAbsolute(computeProtoOverride)
        ? computeProtoOverride
        : resolve(process.cwd(), computeProtoOverride)
      : undefined;

  // 优先级：env 显式配置 > __dirname 相对路径 > cwd 相对路径
  const candidateProtoPaths = [
    overridePath,
    resolve(__dirname, '../../../../proto/compute/compute.proto'),
    resolve(__dirname, '../../../../../proto/compute/compute.proto'),
    resolve(process.cwd(), 'src/proto/compute/compute.proto'),
    resolve(process.cwd(), 'dist/proto/compute/compute.proto'),
  ].filter((p): p is string => Boolean(p));

  const computeProtoPath = candidateProtoPaths.find((p) => existsSync(p));

  // 在配置阶段就失败，避免应用启动后才在调用时暴露问题
  if (!computeProtoPath) {
    throw new Error(
      [
        'gRPC proto 文件不存在，无法初始化 gRPC 客户端配置。',
        '',
        '已尝试以下路径：',
        ...candidateProtoPaths.map((p) => `- ${p}`),
        '',
        '你可以通过环境变量显式指定 proto 路径：',
        '- GRPC_COMPUTE_PROTO_PATH=dist/proto/compute/compute.proto',
      ].join('\n'),
    );
  }

  return {
    compute: {
      url: process.env.GRPC_COMPUTE_URL || 'localhost:50051',
      protoPath: computeProtoPath,
      package: 'compute',
      serviceName: 'ComputeService',
    },
    options: {
      keepalive: {
        timeMs: 10000,
        timeoutMs: 5000,
      },
      defaultTimeout: 30000,
      retryAttempts: 2,
      retryDelay: 1000,
    },
  };
});
```

### Step 3: 定义 Proto 契约

**这一步在干什么**: 创建服务接口契约，作为 NestJS 和 Go 服务之间的通信协议。

```protobuf
// src/proto/compute/compute.proto
/**
 * 计算服务 Proto 定义
 *
 * 此文件定义 NestJS 与 Go 计算服务之间的 gRPC 接口契约
 * 修改后需要确保两端同步更新
 */
syntax = "proto3";

package compute;

// ===== 计算服务 =====
service ComputeService {
  // 同步计算 - 发送请求并等待完整响应
  rpc Calculate(CalculateRequest) returns (CalculateResponse);
  
  // 流式计算 - 发送请求并接收流式响应 (服务端流)
  rpc StreamCalculate(CalculateRequest) returns (stream CalculateChunk);
  
  // 健康检查 (遵循 gRPC 健康检查协议)
  rpc HealthCheck(HealthCheckRequest) returns (HealthCheckResponse);
}

// ===== 消息定义 =====

// 计算请求
message CalculateRequest {
  // 任务唯一标识 (UUID)
  string task_id = 1;
  
  // 任务类型 (如: 'image_process', 'data_analysis', 'ai_inference')
  string task_type = 2;
  
  // 任务负载数据 (JSON 字符串或 Base64 编码的二进制)
  string payload = 3;
  
  // 元数据键值对 (可选)
  map<string, string> metadata = 4;
}

// 计算响应
message CalculateResponse {
  // 任务唯一标识
  string task_id = 1;
  
  // 任务状态: 'success' | 'failed' | 'timeout'
  string status = 2;
  
  // 结果数据 (JSON 字符串或 Base64 编码的二进制)
  string result = 3;
  
  // 执行耗时 (毫秒)
  int64 elapsed_ms = 4;
  
  // 错误信息 (status='failed' 时填充)
  string error_message = 5;
}

// 流式响应块
message CalculateChunk {
  // 任务唯一标识
  string task_id = 1;
  
  // 数据块内容
  string chunk = 2;
  
  // 当前块序号 (从 0 开始)
  int32 index = 3;
  
  // 是否为最后一块
  bool is_final = 4;
}

// 健康检查请求
message HealthCheckRequest {
  // 要检查的服务名 (空字符串表示检查整体)
  string service = 1;
}

// 健康检查响应
message HealthCheckResponse {
  // 服务状态枚举
  enum ServingStatus {
    UNKNOWN = 0;
    SERVING = 1;
    NOT_SERVING = 2;
  }
  
  ServingStatus status = 1;
}

```

### Step 4: 创建 TypeScript 接口

**这一步在干什么**: 定义与 Proto 对应的 TypeScript 类型，提供编译时类型检查。

```typescript
// src/grpc/interfaces/compute.interface.ts
import { Observable } from 'rxjs';

export interface CalculateRequest {
  taskId: string;
  taskType: string;
  payload: string;
  metadata?: Record<string, string>;
}

export interface CalculateResponse {
  taskId: string;
  status: string;
  result: string;
  elapsedMs: number;
  errorMessage?: string;
}

export interface CalculateChunk {
  taskId: string;
  chunk: string;
  index: number;
  isFinal: boolean;
}

export interface ComputeServiceClient {
  calculate(request: CalculateRequest): Observable<CalculateResponse>;
  streamCalculate(request: CalculateRequest): Observable<CalculateChunk>;
  healthCheck(request: { service: string }): Observable<{ status: number }>;
}
```

### Step 5: 实现客户端封装

**这一步在干什么**: 封装 gRPC 客户端，提供友好的 API 和统一的错误处理。

```typescript
// src/grpc/clients/compute-service.client.ts
@Injectable()
export class ComputeServiceClient implements OnModuleInit {
  private computeService: IComputeServiceClient;

  constructor(
    @Inject(GRPC_COMPUTE_SERVICE) private readonly client: ClientGrpc,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    const serviceName = this.configService.get('grpc.compute.serviceName');
    this.computeService = this.client.getService<IComputeServiceClient>(serviceName);
  }

  async calculate(request: CalculateRequest): Promise<CalculateResponse> {
    return firstValueFrom(
      this.computeService.calculate(request).pipe(
        timeout(30000),
        retry(2),
        catchError((error) => this.handleError(error)),
      ),
    );
  }

  streamCalculate(request: CalculateRequest): Observable<CalculateChunk> {
    return this.computeService.streamCalculate(request);
  }
}
```

### Step 6: 创建 gRPC 模块

**这一步在干什么**: 将 gRPC 客户端注册为 NestJS 全局模块，供各业务模块注入使用。

```typescript
// src/grpc/grpc.module.ts
@Global()
@Module({})
export class GrpcModule {
  static registerAsync(): DynamicModule {
    return {
      module: GrpcModule,
      imports: [
        ClientsModule.registerAsync([{
          name: GRPC_COMPUTE_SERVICE,
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            transport: Transport.GRPC,
            options: {
              url: config.get('grpc.compute.url'),
              package: config.get('grpc.compute.package'),
              protoPath: config.get('grpc.compute.protoPath'),
            },
          }),
        }]),
      ],
      providers: [ComputeServiceClient],
      exports: [ComputeServiceClient],
    };
  }
}
```

### Step 7: 在 AppModule 中注册

**这一步在干什么**: 将 gRPC 模块集成到应用根模块。

```typescript
// src/app.module.ts
@Module({
  imports: [
    AppConfigModule,
    GrpcModule.registerAsync(),
    // ... 其他模块
  ],
})
export class AppModule {}
```

### Step 8: 在业务模块中使用

**这一步在干什么**: 在业务 Service 中注入 gRPC 客户端，调用远程服务。

```typescript
// 任意业务 Service
@Injectable()
export class SomeBusinessService {
  constructor(private readonly computeClient: ComputeServiceClient) {}

  async processData(data: any) {
    const result = await this.computeClient.calculate({
      taskId: uuid(),
      taskType: 'process',
      payload: JSON.stringify(data),
    });
    return result;
  }
}
```

---

## 6. 目录结构参考

```
src/
├── grpc/                              # gRPC 客户端模块
│   ├── grpc.module.ts                 # 模块定义
│   ├── index.ts                       # 统一导出
│   ├── constants/
│   │   ├── grpc.constants.ts          # 注入令牌
│   │   └── index.ts
│   ├── clients/
│   │   ├── compute-service.client.ts  # 客户端封装
│   │   └── index.ts
│   ├── interfaces/
│   │   ├── compute.interface.ts       # TypeScript 类型
│   │   └── index.ts
│   └── indicators/
│       ├── grpc-compute.indicator.ts  # 健康检查指示器
│       └── index.ts
│
├── proto/                             # Proto 定义文件
│   └── compute/
│       └── compute.proto
│
└── common/
    └── configs/
        └── config/
            └── grpc.config.ts         # gRPC 配置
```

---

## 7. 扩展阅读

- [NestJS Microservices - gRPC](https://docs.nestjs.com/microservices/grpc)
- [gRPC-js GitHub](https://github.com/grpc/grpc-node/tree/master/packages/grpc-js)
- [Protocol Buffers Language Guide](https://protobuf.dev/programming-guides/proto3/)
