# Code Review Checklist

快速参考清单，供审查者逐项勾选。

## 安全性

- [ ] 所有用户输入经过校验（class-validator / Pipe）
- [ ] 无硬编码的密钥或凭证
- [ ] SQL 查询使用参数化（TypeORM QueryBuilder / Repository API）
- [ ] 敏感端点有权限守卫（@UseGuards）

## 性能

- [ ] 数据库查询无 N+1 问题（使用 relations / QueryBuilder join）
- [ ] 列表接口支持分页
- [ ] 无不必要的 await（可并行的操作使用 Promise.all）
- [ ] 大文件处理使用 Stream

## 架构

- [ ] 每个类/函数职责单一
- [ ] 依赖通过构造函数注入（DIP）
- [ ] 无循环依赖
- [ ] 模块边界清晰（不跨模块直接 import 内部文件）

## TypeScript

- [ ] 无 `any` 类型（确有必要时使用 `unknown` + 类型守卫）
- [ ] 接口/类型定义完整
- [ ] 枚举值使用 `const enum` 或字符串枚举
- [ ] 异步函数返回类型明确标注
