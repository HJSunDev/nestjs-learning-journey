<div align="center">

# 🚀 NestJS Journey

**生产级 NestJS 后端开发实践指南**

一个从零到生产的 NestJS 全栈学习项目，涵盖企业级后端开发的核心技术栈与最佳实践。

[![NestJS](https://img.shields.io/badge/NestJS-11.x-E0234E?style=flat-square&logo=nestjs&logoColor=white)](https://nestjs.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7.2-DC382D?style=flat-square&logo=redis&logoColor=white)](https://redis.io/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com/)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

[功能特性](#-功能特性) •
[快速开始](#-快速开始) •
[项目架构](#-项目架构) •
[学习文档](#-学习文档) •
[部署指南](#-部署指南)

</div>

---

## ✨ 功能特性

### 核心能力

- 🔐 **双 Token 认证** - JWT Access/Refresh Token 机制，支持滑动过期与令牌轮换
- 👥 **RBAC 权限系统** - 基于角色的访问控制，灵活的权限管理
- 📁 **存储层抽象** - 遵循 DIP 原则，支持 Local/OSS 驱动热切换
- 🌐 **gRPC 微服务** - 与 Go 微服务通信，Protocol Buffers 契约设计
- 🤖 **AI 服务集成** - 多模型 Provider 抽象，SSE 流式响应
- 📊 **健康检查** - K8s 就绪/存活探针，PostgreSQL/Redis/gRPC 指示器

### 工程实践

- 📝 **Swagger 文档** - 自动化 API 文档生成，DTO 验证
- 🛡️ **安全加固** - Helmet 头部安全、Rate Limiting 限流、CORS 白名单
- 📋 **Winston 日志** - 分级日志、日志轮转、生产级配置
- 🗄️ **数据库迁移** - TypeORM Migration 系统，版本化表结构管理
- 🐳 **容器化部署** - 多阶段构建、Docker Compose 编排

---

## 🛠️ 技术栈

| 分类 | 技术 |
|------|------|
| **框架** | NestJS 11、Express |
| **语言** | TypeScript 5.7 |
| **数据库** | PostgreSQL 16、TypeORM |
| **缓存** | Redis 7.2、ioredis |
| **认证** | Passport、JWT |
| **文档** | Swagger/OpenAPI |
| **日志** | Winston、DailyRotateFile |
| **微服务** | gRPC、Protocol Buffers |
| **容器化** | Docker、Docker Compose |
| **验证** | class-validator、Joi |

---

## 🚀 快速开始

### 环境要求

- Node.js 22+
- npm 10+
- Docker & Docker Compose (可选)

### 1. 克隆项目

```bash
git clone https://github.com/your-username/nest-journey.git
cd nest-journey
```

### 2. 安装依赖

```bash
npm install
```

### 3. 环境配置

```bash
# 复制环境变量模板
cp env.example .env

# 编辑配置（必填项）
# - DB_USER / DB_PASS: PostgreSQL 凭证
# - REDIS_PASSWORD: Redis 密码
# - JWT_ACCESS_SECRET / JWT_REFRESH_SECRET: JWT 密钥
```

### 4. 启动服务

**方式一：Docker Compose（推荐）**

```bash
# 启动基础设施（PostgreSQL + Redis）
npm run docker:db

# 启动开发环境（含 pgAdmin + Redis Insight）
npm run docker:dev
```

**方式二：手动启动**

确保本地已安装并启动 PostgreSQL 和 Redis。

### 5. 启动应用

```bash
# 开发模式（热重载）
npm run dev

# 生产模式
npm run build && npm run start:prod
```

### 6. 访问服务

| 服务 | 地址 |
|------|------|
| API 服务 | http://localhost:3000 |
| Swagger 文档 | http://localhost:3000/api-docs |
| 健康检查 | http://localhost:3000/health |
| pgAdmin | http://localhost:5050 |
| Redis Insight | http://localhost:5540 |

---

## 📁 项目架构

```
src/
├── main.ts                    # 应用入口
├── app.module.ts              # 根模块
│
├── common/                    # 通用模块
│   ├── configs/               # 配置管理
│   │   ├── config/            # 分层配置（app/db/jwt/redis...）
│   │   ├── app-config.module.ts
│   │   └── setup-swagger.ts
│   ├── decorators/            # 自定义装饰器
│   ├── dto/                   # 通用 DTO
│   ├── entities/              # 基础实体
│   ├── filters/               # 异常过滤器
│   ├── guards/                # 守卫
│   ├── hashing/               # 密码加密服务
│   ├── health/                # 健康检查
│   ├── logger/                # Winston 日志
│   ├── redis/                 # Redis 服务
│   ├── storage/               # 存储抽象层
│   └── utils/                 # 工具函数
│
├── auth/                      # 认证模块
│   ├── strategies/            # Passport 策略
│   ├── guards/                # 认证守卫
│   ├── token-storage/         # Token 存储抽象
│   └── dto/
│
├── user/                      # 用户模块
├── role/                      # 角色模块
├── upload/                    # 文件上传模块
├── ai/                        # AI 服务模块
├── grpc/                      # gRPC 客户端模块
│
├── database/                  # 数据库配置
│   ├── data-source.ts         # TypeORM 数据源
│   └── migrations/            # 迁移文件
│
└── proto/                     # Protocol Buffers
    └── compute/
        └── compute.proto
```

### 架构设计原则

- **三层架构** - Controller → Service → Repository 职责分离
- **依赖倒置** - 面向接口编程，便于测试与扩展
- **模块化** - 高内聚低耦合，按业务域划分模块
- **配置分层** - 敏感信息与业务默认值分离

---

## 📚 学习文档

本项目包含 **39 篇深度学习笔记**，系统性地覆盖 NestJS 后端开发的各个方面。

> 📖 完整目录请查看 [docs/README.md](docs/README.md)

### 文档分类概览

| 分类 | 主题 | 文档数 |
|------|------|--------|
| **基础架构** | CLI、RESTful、Swagger、Controller、DTO | 5 |
| **核心概念** | IoC/DI、模块化、管道、过滤器、拦截器 | 6 |
| **数据层** | TypeORM、PostgreSQL、实体设计、软删除、迁移 | 6 |
| **认证授权** | JWT、Passport、双 Token、RBAC | 5 |
| **基础设施** | Docker、Redis、Winston 日志、配置管理 | 6 |
| **安全加固** | Helmet、Rate Limiting、CORS、密码加密 | 5 |
| **高级特性** | 文件上传、存储抽象、健康检查、gRPC | 6 |

### 精选文档

- [007. IoC 与 DI 核心原理](docs/notes/007-ioc-and-di-principle.md) - 深度解析依赖注入机制
- [024. 双 Token 鉴权机制](docs/notes/024-double-token-authentication.md) - 生产级认证方案
- [032. 存储抽象层设计](docs/notes/032-storage-abstraction-and-design.md) - DIP 原则实战
- [037. 生产级 Dockerfile](docs/notes/037-production-dockerfile.md) - 多阶段构建优化
- [039. gRPC 客户端集成](docs/notes/039-grpc-client-integration.md) - 微服务通信实践

---

## 🐳 部署指南

### Docker Compose 部署

```bash
# 生产环境一键部署（含应用 + 数据库 + Redis）
npm run docker:prod

# 查看应用日志
npm run docker:logs

# 停止所有服务
npm run docker:down
```

### 数据库迁移

```bash
# 生成迁移文件
npm run migration:generate

# 执行迁移
npm run migration:run

# 回滚迁移
npm run migration:revert

# 查看迁移状态
npm run migration:show
```

---

## ⚙️ 环境变量

| 变量 | 必填 | 说明 | 默认值 |
|------|:----:|------|--------|
| `APP_ENV` | - | 运行环境 | `development` |
| `APP_PORT` | - | 服务端口 | `3000` |
| `DB_HOST` | ✅ | PostgreSQL 主机 | - |
| `DB_PORT` | - | PostgreSQL 端口 | `5432` |
| `DB_NAME` | ✅ | 数据库名称 | - |
| `DB_USER` | ✅ | 数据库用户 | - |
| `DB_PASS` | ✅ | 数据库密码 | - |
| `REDIS_HOST` | ✅ | Redis 主机 | - |
| `REDIS_PORT` | - | Redis 端口 | `6379` |
| `REDIS_PASSWORD` | ✅ | Redis 密码 | - |
| `JWT_ACCESS_SECRET` | ✅ | Access Token 密钥 | - |
| `JWT_REFRESH_SECRET` | ✅ | Refresh Token 密钥 | - |
| `CORS_ORIGINS` | - | CORS 白名单 | - |

> 完整配置说明请参考 [env.example](env.example)

---

## 📜 NPM Scripts

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式启动（热重载） |
| `npm run build` | 编译 TypeScript |
| `npm run start:prod` | 生产模式启动 |
| `npm run lint` | ESLint 代码检查 |
| `npm run test` | 运行单元测试 |
| `npm run docker:dev` | 启动开发环境 Docker |
| `npm run docker:prod` | 启动生产环境 Docker |
| `npm run migration:run` | 执行数据库迁移 |

---

## 🤝 参与贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'feat: add amazing feature'`)
4. 推送分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

---

## 📄 开源协议

本项目基于 [MIT License](LICENSE) 开源。

---

<div align="center">

**如果这个项目对你有帮助，欢迎 ⭐ Star 支持！**

</div>
