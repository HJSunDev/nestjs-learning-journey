# Git Commit 生成器

根据项目的 git commit 规范，自动生成符合规范的 commit 消息。

## 执行流程（必须严格遵循）

1. 读取 `.cursor/rules/git-commit-standard.mdc` 获取 commit 规范
2. 执行 `git status` 查看当前变更状态
3. **执行 `git diff --cached --stat` 获取已暂存变更的文件统计（确认文件数量）**
4. **执行 `git diff --cached` 查看完整变更内容，逐文件阅读**
5. **核对：分析的文件数量 == --stat 显示的文件数量**
6. 执行 `git diff` 查看未暂存的变更
7. 根据变更内容和规范生成 commit 消息

## 输出格式

commit 消息必须包裹在代码块中：

```text
<type>(<scope>): <subject>

- 变更点1
- 变更点2
- ...
```

## 规范要点

- 类型：feat / fix / docs / style / refactor / perf / test / chore
- scope 尽可能具体（如：ai/lcel 而非 ai）
- subject 使用英文祈使句，首字母小写，不加句号
- 详细描述使用中文，列出具体实现的功能点