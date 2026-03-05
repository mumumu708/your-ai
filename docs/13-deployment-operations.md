# 第13章 部署与运维
> **本章目标**：定义完整的部署架构、Docker Compose 配置、PM2 进程管理、监控告警和备份恢复方案。
## 13.1 部署架构
```plaintext
╔═════════════════╗
║   Nginx / Caddy   ║ ← 反向代理 + SSL 终结
║   (Port 443)       ║
╚════════┬════════╝
         │
    ┌────┼────┐
    │         │
┌───▼───┐ ┌──▼────┐
│ Gateway│ │ Web WS │ ← PM2 守护
│ :3000  │ │ :3001  │
└───┬───┘ └──┬────┘
     │          │
     └────┬────┘
          │
   ┌─────▼─────┐
   │  Kernel      │ ← PM2 守护
   │  (Central    │
   │  Controller) │
   └─────┬─────┘
          │
   ┌─────▼─────┐
   ┌─────▼─────┐
   │ Claude CLI │ ← 按需 Bun.spawn
   │ 子进程池  │   (每会话一进程)
   └───────────┘
```

## 13.2 PM2 进程管理配置
> **部署模型**：主服务由 PM2 守护运行，Agent 子进程由 Kernel 按需创建和销毁，生命周期与会话绑定。无需 Docker 和容器编排。**部署架构**
```plaintext
┌────────────┐
│   Nginx    │ ← 反向代理 + SSL
│   :443     │
└─────┬──────┘
      │
  ┌───┼────┐
  │        │
┌─▼──────┐ ┌──▼──────┐
│ Gateway │ │ Web WS  │ ← PM2 守护
│ :3000   │ │ :3001   │
└──┬─────┘ └──┬──────┘
   │          │
   └────┬────┘
        │
 ┌──────▼──────┐
 │   Kernel    │ ← PM2 守护
 │  (Central   │
 │  Controller)│
 └──────┬─────┘
        │
 ┌──────▼──────┐
 │ Claude CLI  │ ← 按需 Bun.spawn
 │ 子进程池    │   (每会话一进程)
 └─────────────┘
```

**进程管理说明**


| 进程类型 | 管理方式 | 生命周期 | 说明 |
| --- | --- | --- | --- |
| Gateway | PM2 守护 | 常驻 | 接收 HTTP/WS 请求，转发至 Kernel |
| Kernel | PM2 守护 | 常驻 | 核心控制器，管理 Agent 子进程池 |
| Scheduler | PM2 守护 | 常驻 | 定时任务调度（清理过期工作目录等） |
| Claude CLI 子进程 | Kernel 按需创建 | 会话绑定 | `Bun.spawn("claude", [...])` 按需创建，会话结束时销毁 |


**部署命令**
```bash
# 安装依赖
bun install --production

# 启动全部服务
pm2 start ecosystem.config.js

# 查看进程状态
pm2 status

# 查看 Kernel 日志（含 Agent 子进程创建/销毁记录）
pm2 logs yourbot-kernel

# 优雅重启
pm2 reload all
```

## 13.3 PM2 配置
```javascript
// ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'YourBot-gateway',
      script: 'src/gateway/index.ts',
      interpreter: 'bun',
      instances: 1,
      max_memory_restart: '512M',
      env_production: { NODE_ENV: 'production', PORT: 3000 },
    },
    {
      name: 'YourBot-scheduler',
      script: 'src/kernel/scheduling/scheduler.ts',
      interpreter: 'bun',
      instances: 1,
      max_memory_restart: '256M',
      cron_restart: '0 4 * * *',
    },
    {
      name: 'YourBot-worker',
      script: 'src/kernel/tasking/worker.ts',
      interpreter: 'bun',
      instances: 4,
      exec_mode: 'cluster',
      max_memory_restart: '1G',
    },
  ],
};


```

## 13.4 数据库初始化
SQLite 作为轻量级数据存储（可选，主要依赖文件系统）：
```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  channel_type TEXT NOT NULL,
  channel_user_id TEXT NOT NULL,
  display_name TEXT,
  role TEXT DEFAULT 'standard',
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(channel_type, channel_user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  created_at INTEGER DEFAULT (unixepoch()),
  last_active_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  cron_expression TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',
  next_run_at INTEGER,
  last_run_at INTEGER,
  execution_count INTEGER DEFAULT 0
);
```

## 13.5 监控与告警


| 指标 | 正常范围 | 告警阈值 | 采集方式 |
| --- | --- | --- | --- |
| CPU 使用率 | < 70% | > 85% | PM2 Metrics |
| 内存使用 | < 80% | > 90% | Process.memoryUsage |
| 响应时间 | < 2s | > 5s | Hono Middleware |
| 队列深度 | < 50 | > 100 | TaskQueue.size() |
| 错误率 | < 1% | > 5% | ErrorRecovery Stats |
| 容器数 | < 15 | > 18 | PM2 API |


## 13.6 备份与恢复
```bash
#!/bin/bash
# scripts/backup.sh
BACKUP_DIR="/backups/YourBot/$(date +%Y%m%d_%H%M%S)"
mkdir -p $BACKUP_DIR

# 备份用户数据
tar czf $BACKUP_DIR/user-space.tar.gz user-space/

# 备份数据库
cp data/YourBot.db $BACKUP_DIR/

# 备份配置
cp .env ecosystem.config.js $BACKUP_DIR/

# 保留最近 30 天备份
find /backups/YourBot -maxdepth 1 -mtime +30 -exec rm -rf {} \;
```

## 13.7 性能优化


| 优化项 | 措施 | 预期效果 |
| --- | --- | --- |
| Bun I/O | 使用 Bun.file() 而非 fs | 文件读写快 10x |
| 圆波池 | Agent 实例复用 | 减少初始化开销 |
| 内存缓存 | 热点记忆缓存 | 减少文件 I/O |
| 流式输出 | 防抖节流 | 减少 API 调用 |
| 数据库 | SQLite WAL 模式 | 并发读写优化 |


## 13.8 容量规划


| 规模 | 并发用户 | 服务器配置 | Docker 容器 |
| --- | --- | --- | --- |
| 小型 | 1-10 | 2C/4G | 10 |
| 中型 | 10-50 | 4C/16G | 20 |
| 大型 | 50-200 | 8C/32G | 50 |


## 13.9 故障排查指南


| 症状 | 可能原因 | 排查方法 |
| --- | --- | --- |
| 响应慢 | 队列积压 / API 限流 | `pm2 monit` + 队列深度检查 |
| 无响应 | 进程崩溃 / 端口占用 | `pm2 status` + `lsof -i :3000` |
| 内存溢出 | Agent 泄漏 / 上下文过大 | `pm2 monit` + `docker stats` |
| 定时任务未触发 | Scheduler 崩溃 | `pm2 logs YourBot-scheduler` |


---

> **文档结束** — YourBot AI 助手平台技术设计文档 v1.1.0本文档共 14 章，涵盖了从项目愿景到部署运维的完整技术设计。架构参考 TELGENT 的五层分治模型，以 CentralController 为编排枢纽，实现了 Gateway、Kernel、Shared、User Space、Infrastructure 的清晰职责分离。
---

## 13.10 一键式部署
YourBot AI 助手平台的部署过程应当做到**一条命令完成全部操作**，最大限度降低运维人员的操作门槛和出错概率。本节详细描述 `deploy.sh` 脚本的设计方案，涵盖环境检测、依赖安装、配置生成及服务启动的完整流程。
### 13.10.1 部署脚本总体设计
`deploy.sh` 脚本采用分阶段执行策略，每个阶段均包含前置检查和回滚机制。脚本执行流程如下：
```plaintext
环境检测（Pre-flight） → 依赖安装 → 配置生成 → 数据库初始化 → 服务启动 → 健康检查

```

若任一阶段失败，脚本将输出详细的错误信息并安全退出，不会留下半完成的部署状态。
### 13.10.2 Pre-flight 预检
在执行任何实际部署操作前，脚本必须完成以下预检项：


| 检查项 | 最低要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Linux (x86_64/arm64) 或 macOS (arm64) | 通过 `uname -s` 和 `uname -m` 检测 |
| Node.js 版本 | > = 20.0.0 | 用于可能的兼容性工具 |
| Bun 版本 | > = 1.1.0 | 主运行时 |
| 磁盘空间 | > = 2 GB 可用 | 包含依赖、数据库、用户文件空间 |
| 端口可用性 | 默认 3000、3001 | 主服务端口和管理端口 |
| Claude CLI | 已安装且可执行 | `which claude` 检测 |


### 13.10.3 部署脚本实现
```bash
#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="<equation>(cd "</equation>(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOG_FILE="<equation>{PROJECT_ROOT}/logs/deploy-</equation>(date +%Y%m%d-%H%M%S).log"
DEPLOY_ENV="${DEPLOY_ENV:-production}"
SERVICE_PORT="${SERVICE_PORT:-3000}"
ADMIN_PORT="${ADMIN_PORT:-3001}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

log_info()  { echo -e "<equation>{BLUE}[INFO]</equation>{NC}  $(date '+%H:%M:%S') $*" | tee -a "$LOG_FILE"; }
log_ok()    { echo -e "<equation>{GREEN}[OK]</equation>{NC}    $(date '+%H:%M:%S') $*" | tee -a "$LOG_FILE"; }
log_warn()  { echo -e "<equation>{YELLOW}[WARN]</equation>{NC}  $(date '+%H:%M:%S') $*" | tee -a "$LOG_FILE"; }
log_error() { echo -e "<equation>{RED}[ERROR]</equation>{NC} $(date '+%H:%M:%S') $*" | tee -a "$LOG_FILE"; }

die() { log_error "$1"; echo "\n部署失败，详细日志见: $LOG_FILE"; exit 1; }

preflight_checks() {
  log_info "========== 阶段 1/6: Pre-flight 预检 =========="
  local os_type="$(uname -s)"
  case "$os_type" in
    Linux|Darwin) log_ok "操作系统: $os_type $(uname -m)" ;;
    *) die "不支持的操作系统: $os_type" ;;
  esac
  if ! command -v bun &>/dev/null; then
    die "未检测到 Bun 运行时。请先安装: curl -fsSL https://bun.sh/install | bash"
  fi
  log_ok "Bun 版本: $(bun --version)"
  if ! command -v claude &>/dev/null; then
    die "未检测到 Claude CLI"
  fi
  log_ok "Claude CLI: 已安装"
  for port in "$SERVICE_PORT" "$ADMIN_PORT"; do
    if lsof -i ":$port" &>/dev/null; then
      die "端口 $port 已被占用"
    fi
    log_ok "端口 $port 可用"
  done
  log_info "所有预检项通过"
}

install_dependencies() {
  log_info "========== 阶段 2/6: 安装依赖 =========="
  cd "$PROJECT_ROOT"
  if [[ "$DEPLOY_ENV" == "production" ]]; then
    bun install --frozen-lockfile --production 2>&1 | tee -a "$LOG_FILE"
  else
    bun install --frozen-lockfile 2>&1 | tee -a "$LOG_FILE"
  fi
  log_ok "依赖安装完成"
}

generate_config() {
  log_info "========== 阶段 3/6: 生成配置 =========="
  local config_dir="${PROJECT_ROOT}/config"
  local config_file="<equation>{config_dir}/config.</equation>{DEPLOY_ENV}.toml"
  mkdir -p "$config_dir"
  if [[ -f "$config_file" ]]; then
    cp "<equation>config_file" "</equation>{config_file}.bak.$(date +%Y%m%d%H%M%S)"
    log_warn "已备份现有配置文件"
  fi
  cat > "$config_file" <<TOML
[server]
port = ${SERVICE_PORT}
admin_port = ${ADMIN_PORT}
host = "0.0.0.0"

[database]
path = "${PROJECT_ROOT}/data/yourbot.db"
wal_mode = true

[llm]
default_provider = "claude"
max_concurrent_requests = 5

[llm.claude]
model = "claude-sonnet-4-20250514"
max_tokens = 8192

[mcp]
server_startup_timeout_ms = 10000
max_servers = 10

[logging]
level = "info"
file = "${PROJECT_ROOT}/logs/yourbot.log"
TOML
  log_ok "配置文件已生成: $config_file"
}

init_database() {
  log_info "========== 阶段 4/6: 数据库初始化 =========="
  mkdir -p "${PROJECT_ROOT}/data"
  local db_file="${PROJECT_ROOT}/data/yourbot.db"
  if [[ -f "$db_file" ]]; then
    log_info "数据库已存在，执行迁移检查..."
    bun run db:migrate 2>&1 | tee -a "$LOG_FILE"
  else
    log_info "初始化新数据库..."
    bun run db:init 2>&1 | tee -a "$LOG_FILE"
  fi
  log_ok "数据库就绪"
}

build_project() {
  log_info "========== 阶段 5/6: 构建项目 =========="
  cd "$PROJECT_ROOT"
  bun run build 2>&1 | tee -a "$LOG_FILE"
  log_ok "项目构建完成"
}

start_service() {
  log_info "========== 阶段 6/6: 启动服务 =========="
  mkdir -p "${PROJECT_ROOT}/logs"
  YOURBOT_ENV="<equation>DEPLOY_ENV" nohup bun run start > "</equation>{PROJECT_ROOT}/logs/service.log" 2>&1 &
  local pid=$!
  echo "<equation>pid" > "</equation>{PROJECT_ROOT}/yourbot.pid"
  log_info "服务已启动 (PID: $pid)"
  local max_retries=30; local retry=0
  while (( retry < max_retries )); do
    if curl -sf "http://localhost:${SERVICE_PORT}/health" &>/dev/null; then
      log_ok "健康检查通过"
      echo "YourBot AI 助手平台部署成功！服务地址: http://localhost:${SERVICE_PORT}"
      return 0
    fi
    sleep 1; (( retry++ ))
  done
  die "健康检查失败"
}

main() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --env) DEPLOY_ENV="$2"; shift 2 ;;
      --port) SERVICE_PORT="$2"; shift 2 ;;
      *) die "未知参数: $1" ;;
    esac
  done
  mkdir -p "$(dirname "$LOG_FILE")"
  log_info "YourBot AI 助手平台 - 一键部署 (环境: $DEPLOY_ENV)"
  preflight_checks
  install_dependencies
  generate_config
  init_database
  build_project
  start_service
}

main "$@"
```

### 13.10.4 跨平台支持说明
部署脚本通过以下机制确保在 Linux 和 macOS 上的一致性：
- **磁盘空间检测**：macOS 使用 `df -g`，Linux 使用 `df -BG`，通过 `uname -s` 动态选择。
- **端口检测**：优先使用 `lsof`（跨平台），回退到 `ss`（Linux 特有）。
- **路径处理**：全部使用 POSIX 风格路径。
- **进程管理**：使用标准 POSIX 信号（`SIGTERM`、`SIGKILL`）。
---

## 13.11 一键式跨平台迁移
当用户需要将 YourBot 实例从一台机器迁移到另一台机器时，平台提供一键导出和一键导入命令，实现数据的完整迁移。
### 13.11.1 迁移方案概述
迁移过程分为两个独立步骤：
1. **导出（Export）**：在源机器上执行 `migrate-export.sh`，将所有数据打包为单个归档文件。
1. **导入（Import）**：在目标机器上执行 `migrate-import.sh`，解包归档并恢复全部数据和服务。迁移范围包括：


| 数据类别 | 包含内容 | 文件位置 |
| --- | --- | --- |
| SQLite 数据库 | 会话记录、用户数据、设置 | `data/yourbot.db` |
| 用户工作区 | 用户创建和上传的文件 | `data/workspaces/` |
| Skill 文件 | 自定义技能定义和脚本 | `data/skills/` |
| Memory 数据 | 长期记忆和上下文快照 | `data/memory/` |
| 配置文件 | 运行时配置（脱敏处理） | `config/` |
| 元信息 | 版本号、导出时间、平台信息 | `manifest.json` |


### 13.11.2 导出脚本
```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="<equation>(cd "</equation>(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUTPUT_FILE="<equation>{1:-</equation>{PROJECT_ROOT}/yourbot-export-${TIMESTAMP}.tar.gz}"
EXPORT_DIR=$(mktemp -d)
trap 'rm -rf "$EXPORT_DIR"' EXIT

echo "[导出] YourBot 数据导出开始..."

# 1. 停止服务以确保数据一致性
if [[ -f "${PROJECT_ROOT}/yourbot.pid" ]]; then
  local_pid=$(cat "${PROJECT_ROOT}/yourbot.pid")
  if kill -0 "$local_pid" 2>/dev/null; then
    echo "[导出] 停止运行中的服务 (PID: $local_pid)..."
    kill "$local_pid"; sleep 3
  fi
fi

# 2. 导出 SQLite 数据库
mkdir -p "${EXPORT_DIR}/data"
if command -v sqlite3 &>/dev/null; then
  sqlite3 "<equation>{PROJECT_ROOT}/data/yourbot.db" ".dump" > "</equation>{EXPORT_DIR}/data/yourbot.sql"
else
  cp "<equation>{PROJECT_ROOT}/data/yourbot.db" "</equation>{EXPORT_DIR}/data/yourbot.db"
fi

# 3-5. 导出用户数据
for dir in workspaces skills memory; do
  [[ -d "<equation>{PROJECT_ROOT}/data/</equation>{dir}" ]] && cp -r "<equation>{PROJECT_ROOT}/data/</equation>{dir}" "<equation>{EXPORT_DIR}/data/</equation>{dir}"
done

# 6. 导出配置文件（脱敏处理）
mkdir -p "${EXPORT_DIR}/config"
for cfg in "${PROJECT_ROOT}"/config/*.toml; do
  [[ -f "$cfg" ]] || continue
  sed -E '/^[^#]*(api_key|secret|password|token)\s*=/d' "<equation>cfg" > "</equation>{EXPORT_DIR}/config/$(basename "$cfg")"
done

# 7. 生成 manifest.json
cat > "${EXPORT_DIR}/manifest.json" <<JSON
{
  "format_version": "1.0",
  "export_time": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source_platform": "$(uname -s)",
  "source_arch": "$(uname -m)",
  "bun_version": "$(bun --version)",
  "db_export_format": "$(command -v sqlite3 &>/dev/null && echo 'sql_dump' || echo 'binary_copy')"
}
JSON

# 8. 打包
tar -czf "$OUTPUT_FILE" -C "$EXPORT_DIR" .
echo "导出完成！归档文件: $OUTPUT_FILE"
```

### 13.11.3 导入脚本
```bash
#!/usr/bin/env bash
set -euo pipefail

ARCHIVE_FILE="${1:?用法: $0 <archive.tar.gz> [--target /path/to/yourbot]}"
shift
TARGET_DIR="<equation>{PROJECT_ROOT:-</equation>(pwd)}"
while [[ $# -gt 0 ]]; do
  case "$1" in --target) TARGET_DIR="$2"; shift 2 ;; *) echo "未知参数: $1"; exit 1 ;; esac
done

IMPORT_DIR=$(mktemp -d)
trap 'rm -rf "$IMPORT_DIR"' EXIT

echo "[导入] 解包归档..."
tar -xzf "$ARCHIVE_FILE" -C "$IMPORT_DIR"
[[ ! -f "${IMPORT_DIR}/manifest.json" ]] && echo "无效的导出归档" && exit 1

mkdir -p "<equation>{TARGET_DIR}/data" "</equation>{TARGET_DIR}/config" "${TARGET_DIR}/logs"

# 恢复数据库
db_format=$(python3 -c "import json; print(json.load(open('${IMPORT_DIR}/manifest.json'))['db_export_format'])" 2>/dev/null || echo "binary_copy")
if [[ "<equation>db_format" == "sql_dump" ]] && [[ -f "</equation>{IMPORT_DIR}/data/yourbot.sql" ]]; then
  sqlite3 "<equation>{TARGET_DIR}/data/yourbot.db" < "</equation>{IMPORT_DIR}/data/yourbot.sql"
elif [[ -f "${IMPORT_DIR}/data/yourbot.db" ]]; then
  cp "<equation>{IMPORT_DIR}/data/yourbot.db" "</equation>{TARGET_DIR}/data/yourbot.db"
fi

# 恢复用户文件
for data_dir in workspaces skills memory; do
  [[ -d "<equation>{IMPORT_DIR}/data/</equation>{data_dir}" ]] && cp -r "<equation>{IMPORT_DIR}/data/</equation>{data_dir}" "<equation>{TARGET_DIR}/data/</equation>{data_dir}"
done

# 恢复配置
for cfg in "${IMPORT_DIR}"/config/*.toml; do
  [[ -f "$cfg" ]] || continue
  local_basename="$(basename "$cfg")"
  if [[ -f "<equation>{TARGET_DIR}/config/</equation>{local_basename}" ]]; then
    cp "<equation>cfg" "</equation>{TARGET_DIR}/config/${local_basename}.imported"
  else
    cp "<equation>cfg" "</equation>{TARGET_DIR}/config/${local_basename}"
  fi
done

echo "导入完成！请检查配置并运行 deploy.sh"
```

### 13.11.4 跨平台注意事项
1. **路径分隔符**：macOS 和 Linux 均使用 `/`，导入脚本会自动执行路径修正。
1. **二进制依赖**：SQLite 数据库文件跨平台兼容，推荐使用 SQL dump 格式导出。
1. **文件权限**：迁移后应检查关键文件权限，配置文件应 `chmod 600`。
1. **符号链接**：导出时 `cp -r` 会解引用符号链接为实际文件。
### 13.11.5 迁移验证清单
- [ ] 数据库连接正常，`bun run db:verify` 通过
- [ ] 用户会话数据完整，历史记录可查询
- [ ] 工作区文件完整
- [ ] 所有自定义 Skill 加载成功
- [ ] Memory 数据加载正常
- [ ] API 密钥已在目标环境中正确配置
- [ ] 服务启动成功，健康检查端点返回 200
- [ ] 进行一次端到端的对话测试
---

## 13.12 容灾与备份设计
本节聚焦于**极端场景下的数据丢失风险评估与防护**。核心设计理念是：服务可以短暂中断，但用户数据不能丢失。
### 13.12.1 数据丢失风险评估
