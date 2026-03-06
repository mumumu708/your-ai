# DD-002: AIEOS 协议

- **状态**: Implemented
- **创建日期**: 2026-03-06

## 背景

AI 助手需要个性化配置来定义人格、身份和行为模式。需要一套标准化协议来管理这些配置。

## 目标

定义 AIEOS（AI 助手操作系统）协议，支持全局默认 + 用户级覆盖。

## 方案

### 四个协议文件

| 文件 | 用途 | 填充时机 |
|------|------|---------|
| SOUL.md | AI 核心人格（价值观、风格、边界） | 管理员预设 |
| IDENTITY.md | AI 身份（名字、背景） | Onboarding 时生成 |
| USER.md | 用户画像（兴趣、偏好） | Onboarding + 日常交互 |
| AGENTS.md | Agent 行为配置 | 管理员预设 |

### 三级配置回退

UserConfigLoader 按优先级加载：

1. **本地文件** — `user-space/{userId}/memory/*.md`
2. **OpenViking FS** — 向量存储中的用户配置
3. **全局默认** — `config/*.md`

### 配置流转

```
config/*.md (全局模板)
  → Onboarding 时复制到 user-space/{userId}/memory/
  → 用户交互中逐步个性化
  → UserConfigLoader 加载时优先读取用户级
```

## 注意事项

- 修改 config/ 下文件影响所有新用户
- 已有用户不受影响（已有本地副本）
- 需要全局更新时，需单独设计迁移方案

## 验收标准

- [x] 四个协议文件定义清晰
- [x] 三级回退机制工作正常
- [x] Onboarding 正确复制默认配置
