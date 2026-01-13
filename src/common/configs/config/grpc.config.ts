/**
 * gRPC 客户端配置
 *
 * 用于连接外部 gRPC 服务（如 Go 微服务）
 * 支持多服务注册，每个服务独立配置
 */
import { registerAs } from '@nestjs/config';
import { join, resolve, isAbsolute } from 'path';
import { existsSync } from 'fs';

export default registerAs('grpc', () => {
  // 使用显式配置优先，避免运行时“猜路径”造成排障困难
  const computeProtoOverride = process.env.GRPC_COMPUTE_PROTO_PATH?.trim();

  // 允许传入相对路径（从项目根目录解析），同时兼容绝对路径（容器/K8s 更常见）
  const overridePath =
    computeProtoOverride && computeProtoOverride.length > 0
      ? isAbsolute(computeProtoOverride)
        ? computeProtoOverride
        : resolve(process.cwd(), computeProtoOverride)
      : undefined;

  // 优先级：env 显式配置 > 开发环境(src)相对路径 > 生产环境(dist)相对路径 > 常见兜底路径
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
        '',
        '同时请确保 nest build 会复制 .proto 文件（nest-cli.json -> compilerOptions.assets）。',
      ].join('\n'),
    );
  }

  return {
    // ===== 计算服务配置 =====
    compute: {
      // 服务地址 (host:port)
      url: process.env.GRPC_COMPUTE_URL || 'localhost:50051',
      // Proto 文件绝对路径
      protoPath: computeProtoPath,
      // Proto 包名 (必须与 .proto 文件中的 package 一致)
      package: 'compute',
      // 服务名 (必须与 .proto 文件中的 service 名称一致)
      serviceName: 'ComputeService',
    },

    // ===== 通用 gRPC 选项 =====
    options: {
      // 连接保活配置
      keepalive: {
        // 保活探测间隔 (毫秒)
        timeMs: 10000,
        // 保活探测超时 (毫秒)
        timeoutMs: 5000,
      },
      // 请求默认超时 (毫秒)
      defaultTimeout: 30000,
      // 失败重试次数
      retryAttempts: 2,
      // 重试延迟 (毫秒)
      retryDelay: 1000,
    },
  };
});
