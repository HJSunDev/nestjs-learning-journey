/**
 * gRPC 服务注入令牌
 *
 * 用于 ClientsModule 注册和依赖注入时的标识符
 * 每新增一个 gRPC 服务，需要在此添加对应的常量
 */

/**
 * 计算服务注入令牌
 * 用于注入 Go 端提供的计算密集型服务客户端
 */
export const GRPC_COMPUTE_SERVICE = Symbol('GRPC_COMPUTE_SERVICE');
