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
- **[012. Docker 开发环境与项目启动指南](notes/012-docker-environment.md)**
  - Docker Compose Profile 三模式启动（开发/仅数据库/生产）、服务架构总览及环境恢复速查
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
- **[035. Refresh Token 存储迁移：从数据库到 Redis](notes/035-redis-token-storage.md)**
  - 基于 DIP 原则的 Token 存储抽象、Redis TTL 自动过期机制及生产级 Key 设计规范
- **[036. CORS 跨域配置与配置架构重构](notes/036-cors-and-config-architecture.md)**
  - 生产级 CORS 白名单机制、Swagger UI 跨域支持、配置分层架构及 .env 管理最佳实践
- **[037. 生产级 Docker 构建 (Production Dockerfile)](notes/037-production-dockerfile.md)**
  - 多阶段构建优化镜像体积、Alpine 基础镜像、健康检查配置及 docker-compose 应用服务集成
- **[038. AI 服务模块架构设计 (AI Service Architecture)](notes/038-ai-service-architecture.md)**
  - LangChain 多模型工厂、推理字段归一化 (ReasoningNormalizer)、SSE 流式响应及分层架构设计
- **[039. gRPC 客户端集成与微服务通信 (gRPC Client Integration)](notes/039-grpc-client-integration.md)**
  - NestJS 与 Go 微服务通信、Proto 契约设计、客户端封装最佳实践及健康检查集成
- **[040. 前端流适配方案设计 (Vercel AI SDK Integration Design)](notes/040-vercel-ai-sdk-integration-design.md)**
  - Data Stream Protocol 协议适配、Controller 层双端点架构及 `useChat` 对接方案


## 🤖 阶段三：LangChain 核心架构与工程化

> 在 038-040 建立的多模型工厂 + 流式 SSE 基座之上，补齐 LangChain 的核心抽象能力，为后续智能体开发铺路。

<!-- NEW_AI_CORE_START -->
- ✅ **[041. LCEL 管道与提示词工程 (Prompt Template & LCEL)](notes/041-lcel-and-prompt-template.md)**
  - 基于完全隔离设计，引入 ChatPromptTemplate 与 `.pipe()` 组合语法，构建 prompt | model 基础管道
- ✅ **[042. 结构化输出与 Parser (Structured Output)](notes/042-structured-output.md)**
  - 通过 Zod Schema + `withStructuredOutput` 让 AI 返回强类型 JSON 对象，Schema Registry 注册表模式管理预定义 Schema
- ✅ **[043. 函数调用底层机制 (Tool Calling)](notes/043-tool-calling.md)**
  - 重构 ToolRegistry 为 LangChain 原生 StructuredTool，实现 3 个内置工具，构建 Agentic 工具调用循环引擎
- ✅ **[044. 生产级多轮会话管理 (Memory & Redis)](notes/044-memory-and-redis.md)**
  - 自行实现 RedisChatHistory（零新依赖），RunnableWithMessageHistory 有状态链，WindowedChatHistory 滑动窗口裁剪
- ✅ **[045. RAG 检索增强生成 (Retriever & Vector Store)](notes/045-rag-and-vector-store.md)**
  - 自实现 PgVectorStore（继承 @langchain/core VectorStore），Qwen3-Embedding-8B 向量化，RecursiveCharacterTextSplitter 切块，跑通完整 RAG 链路
- ✅ **[046. 生产级可观测性与韧性 (Observability & Resilience)](notes/046-observability-and-resilience.md)**
  - LangChainTracer 回调链路追踪、ResilienceService（.withRetry() 重试 + .withFallbacks() 降级）、追踪摘要随响应返回、双层超时控制（Per-Call HTTP 超时 + ToolCallingLoop AbortController 聚合超时 → 504）
<!-- NEW_AI_CORE_END -->

## 🛸 阶段四：LangGraph 有状态智能体

> 在 LCEL + Tool Calling 基础之上，进入 LangGraph 状态机驱动的智能体开发。
> 以 OpenClaw 级智能体为理解目标，详细设计参见 [agent-phase-design.md](agent-phase-design.md)。

<!-- NEW_AGENT_START -->
- ✅ **[047. LangGraph 核心：状态图与图编排 (StateGraph Fundamentals)](notes/047-langgraph-state-graph.md)**
  - StateSchema 类型系统（MessagesValue/ReducedValue）、Graph API 声明式图编排、`contextSchema` 运行时注入、替代 ToolCallingLoop 的显式状态图
- ✅ **[048. 生产级 ReAct Agent (ReAct Agent with LangGraph)](notes/048-react-agent.md)**
  - 自建图 + createReactAgent 预构建双模式、ReAct 提示词工程、输入安全守卫（Prompt Injection 防护）、MCP 协议意识
- ✅ **[049. 持久化执行与线程管理 (Durable Execution & Thread Lifecycle)](notes/049-durable-execution.md)**
  - Durable Execution 三模式（sync/async/exit）、PostgresSaver 生产集成、Thread 生命周期管理、Checkpoint Super-step 机制、Time-travel 调试（getStateHistory/fork）、`task()` 持久化语义与幂等性
- ✅ **[050. 人机协同模式 (Human-in-the-Loop Patterns)](notes/050-human-in-the-loop.md)**
  - `interrupt()` 动态中断与 `Command({ resume })` 恢复、二元审批模型（approve / reject，对齐 Claude Agent SDK / OpenAI Agents SDK 生产标准）、`reviewToolCalls` 审批节点 + `Command({ goto })` 动态路由、`autoApproveTools` 分层审批策略
- ✅ **[051. 高级 Agent 模式 (Advanced Agent Patterns)](notes/051-advanced-agent-patterns.md)**
  - Subgraph 模块化组合、Reflection 自我修正（generate → evaluate 循环）、Plan-and-Execute 规划执行（含 tool-graph 子图组合）、模式选型决策树
- 🔲 **052. 记忆体系与运行时扩展 (Memory & Runtime Extensibility)**
  - Store 长期记忆（语义/情景/程序记忆）、Lane Queue 会话串行队列、Skills-as-Markdown 扩展模型
- 🔲 **053. 多智能体协作系统 (Multi-Agent Architecture)**
  - Supervisor（`@langchain/langgraph-supervisor` + 自建）、Handoff（Command 跨图路由）、Subgraph 嵌套与 checkpoint namespace 隔离、OpenClaw Brain-Body-Soul 架构剖析
- 🔲 **054. 生产级 Agent 运维与治理 (Production Agent Operations)**
  - 异步长时运行 + Durable 模式选型、Circuit Breaker 熔断、Contextual Compaction 上下文压缩、安全护栏（Security Agent + Agent 隔离）、MCP 工具标准化、评估指标体系
<!-- NEW_AGENT_END -->

## 📝 维护指南

- 所有的详细笔记存放在 `docs/notes/` 目录下。
- 命名格式：`SEQ-topic-name.md` (例如 `002-controller-basics.md`)。
- 每次新增笔记后，必须更新本文件的目录。
```
