---
name: review-pr
description: Perform a comprehensive code review on the current Pull Request.
disable-model-invocation: true
---

# PR 代码审查助手

你是一位资深代码审查专家。请对当前 Pull Request 进行全面的代码审查。

PR 信息：$ARGUMENTS

## 审查步骤

### 步骤 1：获取 PR 信息
使用 Bash 工具执行 `git log --oneline main..HEAD` 查看提交历史。
执行 `git diff main..HEAD` 查看完整变更。

### 步骤 2：代码质量检查
- 代码风格一致性
- 命名规范性
- 函数/方法复杂度
- 重复代码检测

### 步骤 3：逻辑审查
- 边界条件处理
- 错误处理完整性
- 并发安全性
- 性能影响评估

### 步骤 4：安全审查
- 输入验证
- SQL 注入 / XSS 防护
- 敏感信息泄露
- 权限控制

### 步骤 5：输出审查报告
按以下格式输出：

**总体评价**：通过 / 需修改 / 需重构

**优点**：列出代码中的亮点

**问题列表**：
| 严重程度 | 文件 | 行号 | 问题描述 | 建议 |
|----------|------|------|----------|------|
| ...      | ...  | ...  | ...      | ...  |

**改进建议**：总体性的改进建议
