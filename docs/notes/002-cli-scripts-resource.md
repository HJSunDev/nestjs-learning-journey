# 002. CLI 效率优化与资源生成 (CLI Efficiency & Resource Generation)

## 1. 背景与需求 (Context & Requirements)

- **场景**:
  1. 默认的启动命令 `npm run start:dev` 输入繁琐，希望简洁使用 `npm run dev`。
  2. 自动创建新的业务模块（如用户模块）
- **目标**:
  1. 优化 `package.json` 脚本体验。
  2. 掌握 NestJS CLI 自动化生成标准代码块的方法。

## 2. 核心用法 / 方案设计 (Usage / Design)

### 2.1 NPM 脚本优化 (Script Aliasing)

通过在 `scripts` 中引用已有命令，实现“别名”效果。

**关键代码结构 (`package.json`)**:

```json
"scripts": {
  "start:dev": "nest start --watch",
  // ✅ 推荐：直接引用 start:dev，保持逻辑唯一源
  "dev": "npm run start:dev" 
}
```

### 2.2 模块资源生成 (Resource Generation)

Nest CLI 提供了 `resource` 生成器，一次性生成 Module, Controller, Service, DTO, Entity 及其测试文件。

**核心逻辑流**:

1. 运行生成命令。
2. 选择传输层 (REST API)。
3. 确认生成 CRUD 入口。

## 3. 最佳实践

- ✅ **使用 `npx` 调用本地 CLI**:
  - 避免全局安装 `nest` 命令导致的版本不一致。
  - 使用 `npx nest ...` 确保使用的是当前项目 `node_modules` 下的 CLI 版本。
- ✅ **引用而非复制脚本**:
  - `dev` 命令应该执行 `npm run start:dev`，而不是复制 `nest start --watch`。这样当 `start:dev` 变动时，`dev` 自动同步。
- ❌ **混淆 `npm` 和 `npm run`**:
  - 只有 `start`, `test` 等内置命令可以直接 `npm start`。
  - 自定义命令（如 `dev`）必须使用 `npm run dev`。

## 4. 行动导向 (Action Guide)

### ✅ Task 1: 配置快捷启动指令

1. 打开 `package.json`。
2. 在 `scripts` 区域添加 `"dev": "npm run start:dev"`。
3. 运行 `npm run dev` 验证启动。

### ✅ Task 2: 生成标准业务模块 (以 User 为例)

在项目根目录下运行终端：

```bash
# 使用 npx 确保调用项目内 CLI
npx nest g resource user
```

**交互选项**:

- **Transport layer**: 选择 `REST API`。
- **Generate CRUD entry points**: 输入 `Y` (Yes)。

**结果**:
系统将自动创建 `src/user` 目录，并包含完整的 CRUD 样板代码。
