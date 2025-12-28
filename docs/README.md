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


## 📝 维护指南

- 所有的详细笔记存放在 `docs/notes/` 目录下。
- 命名格式：`SEQ-topic-name.md` (例如 `002-controller-basics.md`)。
- 每次新增笔记后，必须更新本文件的目录。
```
