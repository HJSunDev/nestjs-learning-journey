```
# 📚 NestJS Learning Journey (索引)

这里是项目学习文档的总入口。为了保持轻量和条理，所有的具体知识点都拆分成了独立的原子笔记。

## 🚀 阶段一：环境与启动 (起始)

> 早期记录均存放在根目录的 [LEARNING.md](../LEARNING.md) 中，作为永久存档。

- **[LEARNING.md](../LEARNING.md)**
  - Chapter 1: NestJS 项目初始化 (CLI, Git, Package Manager)

## 🧩 阶段二：核心概念与后端架构

> 新的笔记将自动添加到下方

- **[002. CLI 效率优化与资源生成](notes/002-cli-scripts-resource.md)**
  - NPM 脚本别名配置与 nest g resource 全家桶生成指南
- **[003. RESTful API 风格指南](notes/003-restful-api-basics.md)**
  - 核心理念、URL 资源设计规范与 HTTP 动词最佳实践
- **[004. Swagger 接口文档集成](notes/004-swagger-integration.md)**
  - 自动化文档生成、配置最佳实践及 DTO 继承的元数据处理
- **[005. Controller 与 DTO 详解](notes/005-controller-and-dto.md)**
  - 控制器的职责边界(MVC 演进)、路由装饰器图谱与 DTO 作为数据契约的核心价值
- **[006. 管道(Pipe)与数据校验](notes/006-pipe-validation.md)**
  - Pipe 的拦截原理、ValidationPipe 配置详解(whitelist/transform)及 class-validator 常用装饰器图谱
- **[007. IoC (控制反转) 与 DI (依赖注入) 核心原理](notes/007-ioc-and-di-principle.md)**
  - 深度解析依赖注入机制，脱离框架的原生 TS 实现与 NestJS 容器化管理的对比
- **[008. NestJS 模块化 (Modules) 与共享策略](notes/008-modules-and-sharing.md)**
  - 模块的封装与通信机制，Shared Module 的设计模式及实战代码演示
- **[009. 统一异常处理与 Filter 深度解析](notes/009-exception-filters.md)**
  - 详解 ArgumentsHost 上下文切换、@Catch 装饰器原理及全局异常治理体系搭建
- **[010. 全局配置管理 (Config) 最佳实践](notes/010-configuration.md)**
  - .env 环境变量管理、ConfigModule 全局封装及 Joi 强校验机制解析
- **[011. 数据持久化 (TypeORM + MongoDB)](notes/011-database-persistence.md)**
  - 官方模块(@nestjs/typeorm)使用
  - MongoDB 实体定义、ObjectId 处理及 CRUD 实践
- **[012. Docker 环境集成与数据持久化](notes/012-docker-environment.md)**
  - Docker Compose 编排 MongoDB 服务，Volume 数据挂载与 Git 忽略策略详解
- **[013. Winston 分级日志与日志轮转](notes/013-advanced-logging.md)**
  - Winston 集成、DailyRotateFile 策略、Buffer Logs 原理及生产环境分级配置
- **[014. 三层架构与目录规范](notes/014-three-tier-architecture.md)**
  - 详解 Controller/Service/Repository 职责边界、关注点分离(SoC) 与 NestJS 推荐的领域驱动目录结构
- **[015. 列表分页功能实现 (Pagination)](notes/015-pagination-implementation.md)**
  - 基于 Offset 的分页设计、通用 DTO 封装、class-transformer 类型转换及 TypeORM findAndCount 实战
- **[016. 通用实体与软删除 (Common Entity & Soft Delete)](notes/016-common-entity-and-soft-delete.md)**
  - 抽象基类设计、自动化时间戳 (@CreateDateColumn/@UpdateDateColumn) 及 TypeORM 原生软删除机制详解
- **[017. RBAC 权限系统设计与实现 (TypeORM + MongoDB)](notes/017-rbac-design-and-implementation.md)**
  - RBAC0 模型实现、MongoDB JSON 权限字段设计及 User-Role 关联策略
- **[018. 敏感信息加密与密码加盐 (Hashing & Salting)](notes/018-hashing-and-encryption.md)**
  - 为什么不能明文存储、bcrypt 算法原理、自动盐管理机制及 NestJS 集成最佳实践
- **[019. 拦截器 (Interceptor) 与文件上传流处理](notes/019-interceptor-stream-files.md)**
  - AOP 编程思想、FileInterceptor 解析 multipart/form-data 流原理及 模块集成和适配方案
- **[020. 文件指纹技术与哈希命名 (File Fingerprinting & Hashing)](notes/020-file-fingerprinting-and-hashing.md)**
  - 基于 MD5 的文件去重与命名策略，对比 Bcrypt 与 Crypto 的适用场景
- **[021. 文件上传与图床搭建实战 (Upload & Image Hosting)](notes/021-upload-and-image-hosting.md)**
  - 静态资源映射、Config 结构化配置、path.resolve 路径安全及 Git 忽略规则
- **[022. JWT 认证与 Token 签发 (Sign & Login)](notes/022-jwt-sign-and-login.md)**
  - JWT 机制、手机号登录改造、AuthModule 异步配置及跨模块 Provider 导出规范
- **[023. 全局守卫与 Token 校验 (Global Guard & JWT Strategy)](notes/023-jwt-guard-and-global-auth.md)**
  - Passport 原理、JWT Strategy 实现、全局守卫配置 (APP_GUARD) 及 @Public 装饰器豁免机制
- **[024. 双 Token 鉴权机制 (Access + Refresh Token)](notes/024-double-token-authentication.md)**
  - Access/Refresh Token 机制、滑动过期与令牌轮换 (Rotation) 实现
  - 深度解析 JwtModule、PassportStrategy、AuthGuard 协作原理
- **[025. 敏感数据处理最佳实践 (Sensitive Data Handling)](notes/025-sensitive-data-best-practices.md)**
  - 摒弃全局递归拦截器，采用 DTO + ClassSerializerInterceptor 的工业级方案
  - @Exclude/@Expose 装饰器详解与白名单安全策略
- **[026. Redis 环境集成与 Docker 编排](notes/026-redis-environment-setup.md)**
  - Redis 7.2 容器化部署、AOF 持久化配置、密码安全策略及数据卷挂载指南
- **[027. Redis 应用层集成 (Application Integration)](notes/027-redis-application-integration.md)**
  - ioredis 客户端集成、Global Module 全局封装、Config 动态配置及依赖注入实战
- **[028. 基于 Helmet 的 HTTP 安全加固 (HTTP Security Hardening)](notes/028-http-security-helmet.md)**
  - 详解 HTTP 安全头威胁与 Helmet 防护机制，定制 CSP 策略以完美兼容 Swagger UI
- **[029. 基于 Rate Limiting 的频次控制 (Rate Limiting)](notes/029-rate-limiting.md)**
  - 核心限流方案选型，使用 @nestjs/throttler + Redis 实现分布式限流与防暴破
- **[030. 从 MongoDB 迁移到 PostgreSQL 实战 (Migration Guide)](notes/030-migration-mongo-to-postgres.md)**
  - 架构选型对比、TypeORM 实体层重构、UUID 适配及生产环境日志配置最佳实践
- **[031. 健康检查与监控 (Health Checks)](notes/031-health-checks.md)**
  - @nestjs/terminus 集成、自定义 Redis 指示器、K8s 探针设计及运维监控端点实现
- **[032. 文件存储架构与抽象层设计 (Storage Abstraction)](notes/032-storage-abstraction-and-design.md)**
  - 遵循 DIP 原则的 IStorageService 设计，策略模式实现 Local/OSS 驱动热切换
- **[033. 数据库迁移系统 (TypeORM Migrations)](notes/033-database-migrations.md)**
  - 生产级数据库结构管理，synchronize 的风险、Migration 工作机制及 CLI 配置实战
- **[034. 数据库可视化管理工具集成 (Database Visualization Tools)](notes/034-database-visualization-tools.md)**
  - Docker 集成 pgAdmin/Redis Insight、开发与生产环境访问策略及工具使用指引


## 📝 维护指南

- 所有的详细笔记存放在 `docs/notes/` 目录下。
- 命名格式：`SEQ-topic-name.md` (例如 `002-controller-basics.md`)。
- 每次新增笔记后，必须更新本文件的目录。
```
