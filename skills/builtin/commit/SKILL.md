---
name: commit
description: Generate a Conventional Commits message from staged changes and commit.
disable-model-invocation: true
---

# Git Commit 规范助手

你是一个 Git 版本管理专家。请根据当前工作目录的变更生成符合 Conventional Commits 规范的提交信息。

用户需求：$ARGUMENTS

## 执行步骤

### 步骤 1：检查 Git 状态
使用 Bash 工具执行 `git status` 和 `git diff --cached`，了解当前暂存区的变更。

### 步骤 2：分析变更内容
根据 diff 内容，判断变更类型：
- `feat`: 新功能
- `fix`: 修复 Bug
- `docs`: 文档变更
- `refactor`: 重构
- `test`: 测试相关
- `chore`: 构建/工具相关

### 步骤 3：生成提交信息
格式：`<type>(<scope>): <subject>`

### 步骤 4：执行提交
使用 Bash 工具执行 `git commit -m "<生成的提交信息>"`。

## 注意事项
- 如果暂存区为空，提示用户先使用 `git add` 添加文件
- Subject 行不超过 72 个字符
- Body 部分用中文描述变更的原因和影响
