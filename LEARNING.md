## 🚀 Chapter 1: NestJS 项目初始化

### 1. 项目创建指令 (Project Creation)

NestJS 提供了强大的 CLI (Command Line Interface) 工具来快速生成项目骨架。我们推荐使用 `npx` 来运行 CLI，以确保总是使用最新版本。

根据当前目录结构的不同，有两种初始化方式：

#### 场景 A：已手动创建并进入文件夹（推荐）

如果你已经建好了文件夹（如 `E:\Dev\nest-journey`）并位于该目录下，这是我们**当前项目采用的方式**：

```bash
# 注意命令最后的点 "."，代表在当前目录展开，不新建子文件夹
npx @nestjs/cli new .
```

#### 场景 B：尚未创建文件夹

如果你还在根目录（如 `E:\Dev`），希望 CLI 自动创建文件夹：

```bash
# 这将自动创建一个名为 nest-journey 的新文件夹
npx @nestjs/cli new nest-journey
```

### 2. 包管理器选择 (Package Manager)

在运行创建命令后，CLI 会询问你希望使用哪种包管理器。

**常见选项：**

* `npm` (Node.js 默认) 推荐
* `yarn`
* `pnpm` (Nest Cli对 pnpm支持有问题，会报错)

> **注意**：选择后 CLI 会自动安装依赖 (`node_modules`)。

### 3. 核心工具解析 (Why npx?)

我们使用了 `npx @nestjs/cli` 而不是先全局安装 `npm i -g @nestjs/cli`，主要原因如下：

* **版本一致性**：`npx` 总是从 npm registry 下载临时执行（或使用缓存的最新版），避免了本地全局 CLI 版本过旧导致生成的项目结构过时。
* **环境整洁**：不需要在电脑上全局安装大量工具，保持环境清洁。

### 4. Git 初始化说明

NestJS CLI 默认会自动执行 `git init` 将项目初始化为 Git 仓库，但**默认不会**执行第一次提交 (commit)。

**标准流程：**

1. **检查状态**：`git status` (会看到大量 untracked files)
2. **首次提交**：
   ```bash
   git add .
   git commit -m "feat: initial commit"
   ```
