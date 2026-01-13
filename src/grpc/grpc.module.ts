/**
 * gRPC 客户端模块
 *
 * 职责：
 * 1. 注册 gRPC 客户端连接
 * 2. 提供各服务客户端的依赖注入
 * 3. 全局模块，一次导入，全局可用
 *
 * 设计原则：
 * - 遵循 DIP (依赖倒置)：业务模块依赖客户端抽象，而非 gRPC 底层
 * - 遵循 OCP (开闭原则)：新增服务只需添加配置和客户端，无需修改模块
 */
import { Module, Global, DynamicModule, Logger } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigService, ConfigModule } from '@nestjs/config';
import { GRPC_COMPUTE_SERVICE } from './constants';
import { ComputeServiceClient } from './clients';
import { existsSync } from 'fs';

@Global()
@Module({})
export class GrpcModule {
  private static readonly logger = new Logger('GrpcModule');

  /**
   * 异步注册 gRPC 模块
   *
   * 使用方式：
   * ```typescript
   * @Module({
   *   imports: [GrpcModule.registerAsync()],
   * })
   * export class AppModule {}
   * ```
   */
  static registerAsync(): DynamicModule {
    return {
      module: GrpcModule,
      imports: [
        ClientsModule.registerAsync([
          {
            name: GRPC_COMPUTE_SERVICE,
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => {
              const computeConfig = config.get('grpc.compute');
              const grpcOptions = config.get('grpc.options');

              GrpcModule.logger.log(
                `注册 gRPC 客户端: ${computeConfig.serviceName} -> ${computeConfig.url}`,
              );
              GrpcModule.logger.log(`gRPC protoPath: ${computeConfig.protoPath}`);

              // 提前失败比静默降级更容易定位问题
              if (!existsSync(computeConfig.protoPath)) {
                throw new Error(
                  `gRPC proto 文件不存在: ${computeConfig.protoPath}，请检查 nest-cli.json 的 assets 配置或设置 GRPC_COMPUTE_PROTO_PATH`,
                );
              }

              return {
                transport: Transport.GRPC,
                options: {
                  url: computeConfig.url,
                  package: computeConfig.package,
                  protoPath: computeConfig.protoPath,
                  // Proto 加载器选项
                  loader: {
                    // 保留字段名大小写 (不转换为驼峰)
                    keepCase: false,
                    // 将 int64/uint64 转为字符串 (JS 数字精度限制)
                    longs: String,
                    // 枚举使用字符串名称
                    enums: String,
                    // 为缺失字段填充默认值
                    defaults: true,
                    // 为 oneof 字段输出虚拟字段
                    oneofs: true,
                  },
                  // gRPC 通道选项
                  channelOptions: {
                    // 保活探测间隔 (毫秒)
                    'grpc.keepalive_time_ms': grpcOptions.keepalive.timeMs,
                    // 保活探测超时 (毫秒)
                    'grpc.keepalive_timeout_ms': grpcOptions.keepalive.timeoutMs,
                    // 即使没有活动调用也发送保活探测
                    'grpc.keepalive_permit_without_calls': 1,
                    // 最大接收消息大小 (默认 4MB，可根据需要调整)
                    'grpc.max_receive_message_length': 4 * 1024 * 1024,
                    // 最大发送消息大小 (默认 4MB，可根据需要调整)
                    'grpc.max_send_message_length': 4 * 1024 * 1024,
                  },
                },
              };
            },
          },
        ]),
      ],
      providers: [ComputeServiceClient],
      exports: [ComputeServiceClient],
    };
  }

  /**
   * 同步注册 (用于测试或简单场景)
   *
   * @param options 静态配置选项
   */
  static register(options: {
    url: string;
    protoPath: string;
    package: string;
  }): DynamicModule {
    return {
      module: GrpcModule,
      imports: [
        ClientsModule.register([
          {
            name: GRPC_COMPUTE_SERVICE,
            transport: Transport.GRPC,
            options: {
              url: options.url,
              package: options.package,
              protoPath: options.protoPath,
            },
          },
        ]),
      ],
      providers: [ComputeServiceClient],
      exports: [ComputeServiceClient],
    };
  }
}
