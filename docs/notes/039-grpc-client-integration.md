# 039. gRPC 客户端集成与微服务通信

## 1. 核心问题与概念

### 解决什么问题

NestJS 作为 BFF 层，需要将计算密集型任务（如图像处理、视频转码）交给 Go 服务处理。传统 HTTP/REST 通信存在以下局限：

| 问题            | 影响                                       |
| --------------- | ------------------------------------------ |
| JSON 序列化开销 | 大数据量（如图像二进制）场景下性能损耗明显 |
| 缺乏类型契约    | 接口变更容易导致运行时错误                 |
| 无原生流式支持  | 需要 WebSocket 等额外机制实现流式传输      |

**gRPC 解决方案**：

- **Protobuf 二进制协议**：序列化效率比 JSON 高 3-10 倍
- **强类型契约**：`.proto` 文件作为接口契约，编译时检查
- **原生流式支持**：服务端流、客户端流、双向流
- **HTTP/2 多路复用**：单一 TCP 连接承载所有调用

### 核心架构

```
┌───────────────────────────────────────────────────────
│                    NestJS BFF   
│   
│  ┌────────────────────────────────────────────────────
│  │            GrpcModule (公共模块)  
│  │  
│  │  ClientGrpc ───┬─── ImageServiceClient   
│  │  (单一连接)     |    (图像处理)  
│  │                │   
│  │                └─── (未来) FileServiceClient   
│  │                     (文件处理)  
│  └────────────────────────────────────────────────────
└───────────────────────────────────────────────────────
                           │
                           │ gRPC over HTTP/2 (单一连接)
                           ▼
┌───────────────────────────────────────────────────────
│                   Go 计算服务  
│                   (端口: 50051)   
│                                   
│      grpcServer.RegisterService(&ImageService{})  
│     grpcServer.RegisterService(&HealthService{})  
│    (未来) grpcServer.RegisterService(&FileService{})  
└───────────────────────────────────────────────────────
```

**关键设计**：

- **单一连接**：所有 Service Client 共享同一个 `ClientGrpc` 连接
- **多服务代理**：通过 `client.getService('ImageService')` 获取各自代理
- **HTTP/2 多路复用**：一个 TCP 连接承载 ImageService、FileService 等所有调用

### 依赖

| 包名                      | 角色         | 说明                                    |
| ------------------------- | ------------ | --------------------------------------- |
| `@nestjs/microservices` | 微服务抽象层 | 提供 `ClientGrpc`、`Transport.GRPC` |
| `@grpc/grpc-js`         | gRPC 运行时  | 纯 JS 实现，无需编译 C++                |
| `@grpc/proto-loader`    | Proto 加载器 | 运行时动态解析 `.proto` 文件          |

---

## 2. 核心用法 / 方案设计 (Usage / Design)

### 场景 A: 图像压缩

```typescript
@Injectable()
export class UploadService {
  constructor(private readonly imageClient: ImageServiceClient) {}

  async uploadAndCompress(file: Express.Multer.File): Promise<string> {
    // 调用 Go 服务压缩图像
    const result = await this.imageClient.compress({
      imageData: file.buffer,
      quality: 80,
      outputFormat: ImageFormat.WEBP,
    });

    // 保存压缩后的图像
    const path = await this.saveFile(result.imageData);
  
    return path;
  }
}
```

### 场景 B: 图像缩放

```typescript
async generateThumbnail(imageBuffer: Buffer): Promise<Buffer> {
  const result = await this.imageClient.resize({
    imageData: imageBuffer,
    width: 200,
    height: 200,
    keepAspectRatio: true,
  });

  return result.imageData;
}
```

### 场景 C: 批量处理 (流式)

```typescript
processBatch(images: Buffer[]): Observable<ProcessChunk> {
  return this.imageClient.batchProcess({
    images,
    operation: {
      compress: { quality: 75 },
    },
  });
}

// Controller 中转换为 SSE
@Sse('batch/progress')
batchProgress(@Body() dto: BatchDto): Observable<MessageEvent> {
  return this.uploadService.processBatch(dto.images).pipe(
    map((chunk) => ({
      data: { index: chunk.index, success: chunk.success },
    })),
  );
}
```

### 场景 D: 健康检查集成

```typescript
@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private grpcIndicator: GrpcComputeHealthIndicator,
  ) {}

  @Get()
  check() {
    return this.health.check([
      () => this.grpcIndicator.isHealthy('grpc-compute'),
    ]);
  }
}
```

---

## 3. 深度原理与机制 (Under the Hood)

### gRPC 连接生命周期

```
┌────────────────────────────────────────────────────────────────
│                       NestJS 启动流程  
├────────────────────────────────────────────────────────────────
│  1. AppModule 加载        
│     └─▶ GrpcModule.registerAsync() 执行  
│         └─▶ ClientsModule 创建 ClientGrpc (延迟连接)   
│                                 
│  2. 依赖注入完成                  
│     └─▶ ImageServiceClient 实例化  
│         └─▶ 注入 ClientGrpc (共享连接)   
│                                         
│  3. onModuleInit 生命周期钩子             
│     └─▶ client.getService<T>('ImageService')   
│         └─▶ 解析 .proto 文件                   
│         └─▶ 返回服务代理对象                 
│                                                   
│  4. 首次 RPC 调用时                                 
│     └─▶ 真正建立 TCP 连接                            
│     └─▶ 后续调用复用同一连接 (HTTP/2 多路复用)         
└─────────────────────────────────────────────────────────────────
```

### 单连接多服务原理

```typescript
// 一个 ClientGrpc 连接可以获取多个服务代理
onModuleInit() {
  // 从同一个连接获取不同服务
  this.imageService = this.client.getService<IImageServiceClient>('ImageService');
  this.healthService = this.client.getService<IHealthServiceClient>('HealthService');
  // 未来扩展
  // this.fileService = this.client.getService<IFileServiceClient>('FileService');
}
```

Go 端只需在同一个 gRPC Server 上注册多个服务：

```go
grpcServer := grpc.NewServer()
pb.RegisterImageServiceServer(grpcServer, &ImageServiceImpl{})
pb.RegisterHealthServiceServer(grpcServer, &HealthServiceImpl{})
// 未来扩展
// pb.RegisterFileServiceServer(grpcServer, &FileServiceImpl{})
grpcServer.Serve(listener) // 单一端口 50051
```

### 连接策略深度分析

#### 为什么 HTTP/2 单连接通常足够？

**核心原理**：HTTP/2 的多路复用 (Multiplexing) 允许在同一个 TCP 连接上并发运行成百上千个流 (Streams)。

| 端                         | 运行时特性     | 单连接表现                                                                                                |
| -------------------------- | -------------- | --------------------------------------------------------------------------------------------------------- |
| **Node.js (Client)** | 单线程事件循环 | 维持 1 个 TCP 连接的系统调用开销远小于 100 个连接。处理 100 个流的 I/O 事件在单 Socket 上非常高效         |
| **Go (Server)**      | Goroutine 并发 | 单一 TCP 连接进来后，Go 瞬间"扇出"给成千上万个 Goroutine 并发处理。**瓶颈通常不在连接数，而在 CPU** |

#### 单连接的潜在风险：TCP 队头阻塞

虽然 HTTP/2 解决了**应用层**的阻塞，但 **TCP 层面**仍存在队头阻塞 (Head-of-Line Blocking)：

```
场景：单连接中混杂"大文件上传"和"高频小包请求"

┌─────────────────────────────────────────────────────────────────────
│ TCP 连接 (单一)                                    
│                                                     
│  Stream 1: 上传 10MB 图片 ████████████████████ (丢包!)  
│  Stream 2: 健康检查 ping ·····等待重传·····             
│  Stream 3: 压缩请求     ·····等待重传·····                 
│                         ↑                                   
│                    整个 TCP 窗口阻塞，等待 Stream 1 重传        
└─────────────────────────────────────────────────────────────────────
```

**风险场景**：网络抖动时，大文件的数据包丢失会导致同一连接上的小请求也变卡。

#### 连接策略决策维度

根据**部署架构**和**业务负载**决定连接策略，而非盲目追求"单连接"或"多连接"：

**决策一：后端是单体/聚合服务**

```
现状：Go 服务是 compute-service，包含 Image/File/Health，部署在同一进程

推荐：✅ 单一连接

理由：
- 服务端是同一个 IP:Port
- 建立多条 TCP 连接到同一目标，除了增加握手开销和心跳流量外无显著优势
- 这是本项目当前采用的方案
```

**决策二：后端是微服务群**

```
现状：Go 服务拆分，image-service 在 Pod A，file-service 在 Pod B

推荐：✅ 多连接

理由：
- 物理地址不同，必须建立不同连接
- GrpcModule 应注册 GRPC_IMAGE_CLIENT 和 GRPC_FILE_CLIENT，指向不同 URL
```

**决策三：舱壁隔离 (Bulkhead Pattern)**

```
现状：Go 服务还是一个，但存在资源争抢风险
      - CompressImage: 极耗带宽 (传 10MB 图片)
      - HealthCheck: 极敏感 (必须毫秒级响应)

推荐：✅ 人为拆分连接

理由：
- 舱壁隔离：不让大流量业务把 TCP 拥塞窗口占满
- 即使指向同一 Go 服务 IP，也注册两个 Client：
  - GRPC_HEAVY_CLIENT (用于传图)
  - GRPC_REALTIME_CLIENT (用于健康检查/实时流)
- 防止"一损俱损"
```

#### 生产级考量：负载均衡

 **Pod 是什么（Kubernetes 基础）**：

- **Pod**：Kubernetes 中部署应用的最小单位，可以把它理解为“一个服务实例”。一个 Pod 里通常跑一个 Go 进程（也可能包含 sidecar）。
- **副本 (replicas)**：为了扩容和高可用，同一个服务会启动多个 Pod（例如 10 个），它们运行同一份代码，但有不同的 IP。
- **Service(DNS 名称)**：Kubernetes 会为一组 Pod 提供一个稳定的访问入口（域名/虚拟 IP）。客户端通常通过这个域名访问后端，而不是直接访问某个 Pod IP。
- **为什么这会影响 gRPC**：gRPC 通常是**长连接**。当客户端第一次连上某个 Pod 后，后续请求会继续走这条连接；如果客户端只维护一条连接，就可能导致流量长期“黏”在某一个 Pod 上。

gRPC 长连接与 Kubernetes 的负载均衡存在冲突，这是最容易踩的坑：

```
场景：Go 服务在 K8s 上部署了 10 个 Pod

问题：
1. NestJS 启动时，DNS 解析返回所有 IP
2. 标准 gRPC Client 只选一个建立长连接
3. 结果：所有流量打到某一个 Pod，另外 9 个闲着

┌─────────┐     ┌─────────┐
│ NestJS  │────>│ Pod 1   │ ← 100% 流量
└─────────┘     ├─────────┤
                │ Pod 2   │ ← 0%
                ├─────────┤
                │ Pod 3   │ ← 0%
                └─────────┘
```

**解决方案**：

| 方案                     | 实现                               | 说明                                                       |
| ------------------------ | ---------------------------------- | ---------------------------------------------------------- |
| **客户端负载均衡** | 配置 gRPC 使用 `RoundRobin` 策略 | `grpc-js` 内部维护子通道 (Subchannels) 连接到所有后端 IP |
| **服务端负载均衡** | 使用 Envoy / Istio / Nginx (L7 LB) | NestJS 连接到代理，代理将每个 Request 均匀分发             |

#### 本项目的策略选择

基于当前架构 (NestJS BFF -> 聚合的 Go Compute Service)：

```
选择：单一连接 + 多服务代理

理由：
1. Go 服务是单体部署，物理上只有一个 IP:Port
2. 尚未出现资源争抢的实际问题
3. 避免引入不必要的连接管理复杂度

何时重新评估：
1. 物理拆分：Go 的 ImageService 和 FileService 部署到不同容器
2. 资源争抢：上传大图片时健康检查频繁超时 (TCP 拥塞)
3. 负载不均：K8s 多副本时发现流量集中在单一 Pod
```

---

## 4. 最佳实践与坑 (Best Practices & Pitfalls)

### ✅ 推荐做法

1. **按业务领域定义 Service**

   ```protobuf
   // ✅ 每个业务有独立的 Service 和强类型接口
   service ImageService {
     rpc Compress(CompressRequest) returns (CompressResponse);
     rpc Resize(ResizeRequest) returns (ResizeResponse);
   }
   ```
2. **单连接多服务**

   - 一个 `ClientGrpc` 连接，多个 Service Client
   - 利用 HTTP/2 多路复用，减少连接开销
3. **Proto 文件版本管理**

   - 将 `src/proto/` 纳入 Git
   - 生产环境考虑独立 Proto 仓库

### ❌ 避免做法

1. **避免"通用计算器"设计**

   ```protobuf
   // ❌ 失去类型安全
   service ComputeService {
     rpc Calculate(CalculateRequest) returns (CalculateResponse);
   }
   message CalculateRequest {
     string task_type = 1;  // "compress", "resize"
     string payload = 2;    // JSON 字符串
   }
   ```
2. **避免多连接**

   ```typescript
   // ❌ 每个服务独立连接
   GRPC_IMAGE_SERVICE -> localhost:50051
   GRPC_FILE_SERVICE  -> localhost:50052

   // ✅ 单一连接，多服务代理
   GRPC_COMPUTE_SERVICE -> localhost:50051
     ├── ImageService
     └── FileService
   ```

---

## 5. 行动导向 (Action Guide)

### Step 1: 安装依赖

```bash
npm install @nestjs/microservices @grpc/grpc-js @grpc/proto-loader
```

### Step 2: 配置 nest-cli.json

**这一步在干什么**: 让 `nest build` 自动复制 `.proto` 文件到 `dist` 目录。

```json
{
  "compilerOptions": {
    "deleteOutDir": true,
    "assets": [
      { "include": "**/*.proto", "watchAssets": true }
    ]
  }
}
```

### Step 3: 定义 Proto 契约

**这一步在干什么**: 在一个 Proto 文件中定义多个业务 Service，共享同一个连接。

```protobuf
// src/proto/compute/compute.proto
syntax = "proto3";
package compute;

// 图像处理服务
service ImageService {
  rpc Compress(CompressRequest) returns (CompressResponse);
  rpc Resize(ResizeRequest) returns (ResizeResponse);
  rpc Watermark(WatermarkRequest) returns (WatermarkResponse);
  rpc BatchProcess(BatchProcessRequest) returns (stream ProcessChunk);
}

// 健康检查服务
service HealthService {
  rpc Check(HealthCheckRequest) returns (HealthCheckResponse);
}

// 消息定义...
message CompressRequest {
  bytes image_data = 1;
  int32 quality = 2;
  ImageFormat output_format = 3;
}

message CompressResponse {
  bytes image_data = 1;
  int64 original_size = 2;
  int64 compressed_size = 3;
  float compression_ratio = 4;
  int64 elapsed_ms = 5;
}
// ... 其他消息定义
```

### Step 4: 创建 gRPC 配置

```typescript
// src/common/configs/config/grpc.config.ts
export default registerAs('grpc', () => ({
  compute: {
    url: process.env.GRPC_COMPUTE_URL || 'localhost:50051',
    protoPath: resolveProtoPath('compute/compute.proto'),
    package: 'compute',
  },
  options: {
    keepalive: { timeMs: 10000, timeoutMs: 5000 },
    defaultTimeout: 30000,
    retryAttempts: 2,
    retryDelay: 1000,
  },
}));
```

### Step 5: 创建业务 Client

**这一步在干什么**: 从共享连接获取服务代理，封装业务方法。

```typescript
// src/grpc/clients/image-service.client.ts
@Injectable()
export class ImageServiceClient implements OnModuleInit {
  private imageService: IImageServiceClient;
  private healthService: IHealthServiceClient;

  constructor(
    @Inject(GRPC_COMPUTE_SERVICE) private readonly client: ClientGrpc,
  ) {}

  onModuleInit() {
    // 从同一连接获取多个服务代理
    this.imageService = this.client.getService<IImageServiceClient>('ImageService');
    this.healthService = this.client.getService<IHealthServiceClient>('HealthService');
  }

  async compress(request: CompressRequest): Promise<CompressResponse> {
    return firstValueFrom(
      this.imageService.compress(request).pipe(
        timeout(30000),
        retry(2),
      ),
    );
  }
  // ... 其他方法
}
```

### Step 6: 注册 GrpcModule

**这一步在干什么**: 建立单一连接，注册所有业务 Client。

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
          useFactory: (config) => ({
            transport: Transport.GRPC,
            options: {
              url: config.get('grpc.compute.url'),
              package: config.get('grpc.compute.package'),
              protoPath: config.get('grpc.compute.protoPath'),
            },
          }),
        }]),
      ],
      // 所有业务 Client 共享同一连接
      providers: [
        ImageServiceClient,
        // 未来扩展: FileServiceClient,
      ],
      exports: [
        ImageServiceClient,
        // 未来扩展: FileServiceClient,
      ],
    };
  }
}
```

---

## 6. 目录结构

```
src/
├── grpc/                              # gRPC 客户端模块
│   ├── grpc.module.ts                 # 模块定义 (单一连接)
│   ├── index.ts                       # 统一导出
│   ├── constants/
│   │   └── grpc.constants.ts          # 注入令牌 GRPC_COMPUTE_SERVICE
│   ├── clients/
│   │   ├── image-service.client.ts    # 图像处理客户端
│   │   └── index.ts
│   ├── interfaces/
│   │   ├── compute.interface.ts       # TypeScript 类型
│   │   └── index.ts
│   └── indicators/
│       └── grpc-compute.indicator.ts  # 健康检查指示器
│
├── proto/
│   └── compute/
│       └── compute.proto              # 包含多个 Service 定义
│
└── common/configs/config/
    └── grpc.config.ts                 # gRPC 配置
```

---

## 7. 扩展指南

若需新增业务 Client（如 FileServiceClient），只需：

1. **在 Proto 中添加 Service**

   ```protobuf
   service FileService {
     rpc Compress(FileCompressRequest) returns (FileCompressResponse);
     rpc Extract(ExtractRequest) returns (ExtractResponse);
   }
   ```
2. **在 interfaces 中添加类型**
3. **创建 `clients/file-service.client.ts`**

   ```typescript
   @Injectable()
   export class FileServiceClient implements OnModuleInit {
     private fileService: IFileServiceClient;

     constructor(
       @Inject(GRPC_COMPUTE_SERVICE) private readonly client: ClientGrpc,
     ) {}

     onModuleInit() {
       // 从同一连接获取 FileService 代理
       this.fileService = this.client.getService<IFileServiceClient>('FileService');
     }
   }
   ```
4. **在 GrpcModule 中注册**

   ```typescript
   providers: [ImageServiceClient, FileServiceClient],
   exports: [ImageServiceClient, FileServiceClient],
   ```

Go 端只需在同一个 gRPC Server 上注册新服务即可，无需新增端口。

---

## 8. 扩展阅读

- [NestJS Microservices - gRPC](https://docs.nestjs.com/microservices/grpc)
- [gRPC-js GitHub](https://github.com/grpc/grpc-node/tree/master/packages/grpc-js)
- [Protocol Buffers Language Guide](https://protobuf.dev/programming-guides/proto3/)
