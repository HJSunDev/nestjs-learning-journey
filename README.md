# NestJS 学习项目

这是一个用于学习 NestJS 框架的示例项目，记录从项目创建到开发的完整过程。

## 开发日志

### Day 1: 项目初始化

1. 创建项目

   - npx @nestjs/cli new nestjs-learning
2. 添加开发环境优化配

   - 在 `package.json` 中添加更方便的开发环境命令：
   - `"dev": "nest start --watch",`
3. 集成 Swagger API 文档功能

   - 安装 Swagger 依赖包：`npm install --save @nestjs/swagger`
   - 新增 `src/config/swagger.config.ts` 配置文件

     - 配置了 Swagger UI 界面的主标题和浏览器标签页标题
     - 添加了 Bearer Token 认证支持
   - tsconfig.json配置文件新增配置 `"resolveJsonModule": true,`
   - 在 `main.ts` 中初始化并启用 Swagger 文档功能

## 学习要点

- [ ] 模块（Modules）
- [ ] 控制器（Controllers）
- [ ] 提供者（Providers）
- [ ] 中间件（Middleware）
- [ ] 异常过滤器（Exception filters）
- [ ] 管道（Pipes）
- [ ] 守卫（Guards）
- [ ] 拦截器（Interceptors）
- [ ] 自定义装饰器（Custom decorators）

## 参考资源

- [NestJS 官方文档](https://docs.nestjs.com/)
- [NestJS 中文文档](https://docs.nestjs.cn/)

## 注意事项

- 确保在开发过程中遵循 NestJS 的最佳实践
- 代码变更请及时提交并更新文档
- 重要的代码片段建议添加注释说明

## 贡献

欢迎提交 Issue 和 Pull Request 来完善这个学习项目。

## 许可证

[MIT License](LICENSE)
