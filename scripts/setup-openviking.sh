#!/usr/bin/env bash
# ============================================================
#  OpenViking 一键部署脚本
#  适用于 macOS (Intel/Apple Silicon) 和 Linux (x86_64/aarch64)
#
#  用法:
#    chmod +x scripts/setup-openviking.sh
#    ./scripts/setup-openviking.sh
#
#  前置要求: Python 3.10+, pip, Go 1.21+ (脚本会自动检测并尝试安装)
#  可选环境变量:
#    VOLCENGINE_API_KEY   — 火山引擎 API Key (必填)
#    OV_PORT              — OpenViking 端口 (默认 1933)
#    OV_VLM_MODEL         — VLM 模型 (默认 doubao-seed-1-8-251228)
#    OV_EMBEDDING_MODEL   — Embedding 模型 (默认 doubao-embedding-vision-250615)
# ============================================================

set -euo pipefail

# ── 颜色 ──────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
step()  { echo -e "\n${CYAN}━━━ $* ━━━${NC}"; }

# ── 环境变量 & 默认值 ─────────────────────────────────────
VOLCENGINE_API_KEY="${VOLCENGINE_API_KEY:-}"
OV_PORT="${OV_PORT:-1933}"
OV_VLM_MODEL="${OV_VLM_MODEL:-doubao-seed-1-8-251228}"
OV_EMBEDDING_MODEL="${OV_EMBEDDING_MODEL:-doubao-embedding-vision-250615}"
OV_CONF_DIR="$HOME/.openviking"
OV_CONF_FILE="$OV_CONF_DIR/ov.conf"

OS="$(uname -s)"   # Darwin / Linux
ARCH="$(uname -m)" # arm64 / x86_64 / aarch64

# ── 0. 检查 API Key ──────────────────────────────────────
step "Step 0: 检查环境变量"

if [ -z "$VOLCENGINE_API_KEY" ]; then
  # 尝试从 .env 读取
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
  if [ -f "$PROJECT_ROOT/.env" ]; then
    VOLCENGINE_API_KEY=$(grep '^VOLCENGINE_API_KEY=' "$PROJECT_ROOT/.env" | cut -d'=' -f2 | tr -d '[:space:]')
  fi
fi

if [ -z "$VOLCENGINE_API_KEY" ]; then
  error "VOLCENGINE_API_KEY 未设置。请先设置: export VOLCENGINE_API_KEY=your-key"
fi
info "API Key: ${VOLCENGINE_API_KEY:0:8}...${VOLCENGINE_API_KEY: -4}"
info "平台: $OS / $ARCH"

# ── 1. 安装 Python 依赖 ──────────────────────────────────
step "Step 1: 安装 OpenViking Python 包"

# 检查 Python 版本
PYTHON=""
for cmd in python3.11 python3.12 python3.13 python3; do
  if command -v "$cmd" &>/dev/null; then
    PY_VER=$("$cmd" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
    PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
    PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
    if [ "$PY_MAJOR" -ge 3 ] && [ "$PY_MINOR" -ge 10 ]; then
      PYTHON="$cmd"
      break
    fi
  fi
done

if [ -z "$PYTHON" ]; then
  error "需要 Python 3.10+。请先安装: brew install python@3.11 (macOS) 或 apt install python3.11 (Linux)"
fi
info "Python: $($PYTHON --version)"

PIP="$PYTHON -m pip"
$PIP install --upgrade openviking 2>&1 | tail -3
info "OpenViking Python 包安装完成"

OV_VERSION=$($PYTHON -c "import openviking; print(openviking.__version__)" 2>/dev/null || echo "unknown")
info "OpenViking 版本: $OV_VERSION"

# ── 2. 修复 agfs-server 二进制 ─────────────────────────
step "Step 2: 检查 agfs-server 二进制兼容性"

# 找到 openviking 包的安装路径
OV_PKG_DIR=$($PYTHON -c "import openviking; import os; print(os.path.dirname(openviking.__file__))")
AGFS_BIN="$OV_PKG_DIR/bin/agfs-server"

if [ ! -f "$AGFS_BIN" ]; then
  warn "agfs-server 二进制不存在: $AGFS_BIN"
  NEED_BUILD=true
else
  # 检查二进制是否与当前平台兼容
  FILE_INFO=$(file "$AGFS_BIN")
  NEED_BUILD=false

  case "$OS" in
    Darwin)
      if ! echo "$FILE_INFO" | grep -q "Mach-O"; then
        warn "agfs-server 不是 macOS 二进制 (当前: $FILE_INFO)"
        NEED_BUILD=true
      elif [ "$ARCH" = "arm64" ] && ! echo "$FILE_INFO" | grep -q "arm64"; then
        warn "agfs-server 不是 ARM64 二进制 (当前: $FILE_INFO)"
        NEED_BUILD=true
      elif [ "$ARCH" = "x86_64" ] && ! echo "$FILE_INFO" | grep -q "x86_64"; then
        warn "agfs-server 不是 x86_64 二进制 (当前: $FILE_INFO)"
        NEED_BUILD=true
      fi
      ;;
    Linux)
      if ! echo "$FILE_INFO" | grep -q "ELF"; then
        warn "agfs-server 不是 Linux 二进制 (当前: $FILE_INFO)"
        NEED_BUILD=true
      elif [ "$ARCH" = "aarch64" ] && ! echo "$FILE_INFO" | grep -q "aarch64\|ARM aarch64"; then
        warn "agfs-server 不是 aarch64 二进制"
        NEED_BUILD=true
      elif [ "$ARCH" = "x86_64" ] && echo "$FILE_INFO" | grep -q "aarch64\|ARM"; then
        warn "agfs-server 不是 x86_64 二进制"
        NEED_BUILD=true
      fi
      ;;
  esac

  if [ "$NEED_BUILD" = false ]; then
    info "agfs-server 二进制兼容当前平台 ✓"
  fi
fi

# ── 3. 从源码编译 agfs-server (如需要) ───────────────────
if [ "$NEED_BUILD" = true ]; then
  step "Step 3: 从源码编译 agfs-server"

  # 检查 Go
  GO=""
  for cmd in go /opt/homebrew/bin/go /usr/local/go/bin/go; do
    if command -v "$cmd" &>/dev/null || [ -x "$cmd" ]; then
      GO_VER=$("$cmd" version 2>/dev/null | grep -oE 'go[0-9]+\.[0-9]+' | head -1 | sed 's/go//')
      GO_MAJOR=$(echo "$GO_VER" | cut -d. -f1)
      GO_MINOR=$(echo "$GO_VER" | cut -d. -f2)
      if [ "$GO_MAJOR" -ge 1 ] && [ "$GO_MINOR" -ge 21 ]; then
        GO="$cmd"
        break
      fi
    fi
  done

  if [ -z "$GO" ]; then
    warn "Go 1.21+ 未找到，尝试安装..."
    if [ "$OS" = "Darwin" ] && command -v brew &>/dev/null; then
      brew install go 2>&1 | tail -3
      GO="$(brew --prefix)/bin/go"
    elif [ "$OS" = "Linux" ]; then
      # 下载官方 Go 二进制
      GO_DL_ARCH="amd64"
      [ "$ARCH" = "aarch64" ] && GO_DL_ARCH="arm64"
      GO_LATEST=$(curl -sL 'https://go.dev/dl/?mode=json' | grep -oE '"go[0-9]+\.[0-9]+\.[0-9]+"' | head -1 | tr -d '"')
      if [ -z "$GO_LATEST" ]; then GO_LATEST="go1.23.0"; fi
      info "下载 $GO_LATEST for linux/$GO_DL_ARCH..."
      curl -sL "https://go.dev/dl/${GO_LATEST}.linux-${GO_DL_ARCH}.tar.gz" | sudo tar -C /usr/local -xzf -
      GO="/usr/local/go/bin/go"
    else
      error "无法自动安装 Go，请手动安装 Go 1.21+: https://go.dev/dl/"
    fi
  fi

  info "Go: $($GO version)"

  # 克隆 OpenViking 源码并编译 agfs-server
  TMPDIR=$(mktemp -d)
  info "克隆 OpenViking 源码到 $TMPDIR ..."
  git clone --depth 1 https://github.com/volcengine/OpenViking.git "$TMPDIR/openviking-src" 2>&1 | tail -2

  AGFS_SRC="$TMPDIR/openviking-src/third_party/agfs/agfs-server"
  if [ ! -d "$AGFS_SRC" ]; then
    error "agfs-server 源码目录不存在: $AGFS_SRC"
  fi

  info "编译 agfs-server ..."
  cd "$AGFS_SRC"
  PATH="$(dirname "$GO"):$PATH" make build 2>&1 | tail -3

  BUILT_BIN="$AGFS_SRC/build/agfs-server"
  if [ ! -f "$BUILT_BIN" ]; then
    error "编译失败: $BUILT_BIN 不存在"
  fi

  # 验证编译结果
  info "编译结果: $(file "$BUILT_BIN")"

  # 备份并替换
  if [ -f "$AGFS_BIN" ]; then
    cp "$AGFS_BIN" "${AGFS_BIN}.bak.$(date +%Y%m%d%H%M%S)"
    info "已备份原二进制"
  fi

  cp "$BUILT_BIN" "$AGFS_BIN"
  chmod +x "$AGFS_BIN"
  info "agfs-server 已替换 ✓"

  # 清理
  rm -rf "$TMPDIR"
  cd - >/dev/null
else
  step "Step 3: 跳过编译 (二进制已兼容)"
fi

# ── 4. 生成 ov.conf ───────────────────────────────────────
step "Step 4: 生成 OpenViking 配置文件"

mkdir -p "$OV_CONF_DIR"

if [ -f "$OV_CONF_FILE" ]; then
  warn "配置文件已存在: $OV_CONF_FILE"
  read -r -p "是否覆盖? [y/N] " REPLY
  if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
    info "保留现有配置"
  else
    WRITE_CONF=true
  fi
else
  WRITE_CONF=true
fi

if [ "${WRITE_CONF:-false}" = true ] || [ ! -f "$OV_CONF_FILE" ]; then
  cat > "$OV_CONF_FILE" << EOFCONF
{
  "vlm": {
    "provider": "volcengine",
    "api_key": "$VOLCENGINE_API_KEY",
    "model": "$OV_VLM_MODEL",
    "api_base": "https://ark.cn-beijing.volces.com/api/coding/v3",
    "temperature": 0.1,
    "max_retries": 3
  },
  "embedding": {
    "dense": {
      "provider": "volcengine",
      "api_key": "$VOLCENGINE_API_KEY",
      "model": "$OV_EMBEDDING_MODEL",
      "api_base": "https://ark.cn-beijing.volces.com/api/v3",
      "dimension": 1024,
      "input": "multimodal"
    }
  },
  "storage": {
    "workspace": "./openviking-data",
    "agfs": {
      "backend": "local"
    },
    "vectordb": {
      "backend": "local",
      "name": "memory_context"
    }
  },
  "server": {
    "host": "127.0.0.1",
    "port": $OV_PORT
  }
}
EOFCONF
  info "配置文件已生成: $OV_CONF_FILE"
fi

# ── 5. 启动 OpenViking 服务 ───────────────────────────────
step "Step 5: 启动 OpenViking 服务"

# 检查端口是否被占用
if lsof -ti:"$OV_PORT" &>/dev/null; then
  warn "端口 $OV_PORT 已被占用"
  EXISTING_PID=$(lsof -ti:"$OV_PORT" | head -1)
  EXISTING_CMD=$(ps -p "$EXISTING_PID" -o comm= 2>/dev/null || echo "unknown")
  if echo "$EXISTING_CMD" | grep -qi "python\|openviking\|uvicorn"; then
    info "看起来 OpenViking 已在运行 (PID: $EXISTING_PID)"
    OV_ALREADY_RUNNING=true
  else
    error "端口 $OV_PORT 被其他进程占用 (PID: $EXISTING_PID, CMD: $EXISTING_CMD)。请先释放端口或设置 OV_PORT 环境变量"
  fi
fi

if [ "${OV_ALREADY_RUNNING:-false}" = false ]; then
  # 清理可能的残留锁文件
  LOCK_FILE="./openviking-data/vectordb/memory_context/store/LOCK"
  if [ -f "$LOCK_FILE" ]; then
    warn "发现残留锁文件，清理: $LOCK_FILE"
    rm -f "$LOCK_FILE"
  fi

  nohup openviking-server --config "$OV_CONF_FILE" > /tmp/openviking-server.log 2>&1 &
  OV_PID=$!
  info "OpenViking 启动中 (PID: $OV_PID) ..."

  # 等待服务就绪
  RETRIES=0
  MAX_RETRIES=30
  while [ $RETRIES -lt $MAX_RETRIES ]; do
    if curl -sf "http://127.0.0.1:${OV_PORT}/health" &>/dev/null; then
      break
    fi
    RETRIES=$((RETRIES + 1))
    sleep 1
  done

  if [ $RETRIES -ge $MAX_RETRIES ]; then
    warn "OpenViking 启动超时，查看日志:"
    cat /tmp/openviking-server.log | tail -20
    error "OpenViking 启动失败"
  fi
fi

# 健康检查
HEALTH=$(curl -sf "http://127.0.0.1:${OV_PORT}/health" 2>/dev/null || echo '{"status":"error"}')
READY=$(curl -sf "http://127.0.0.1:${OV_PORT}/ready" 2>/dev/null || echo '{"status":"error"}')

info "Health: $HEALTH"
info "Ready:  $READY"

if echo "$HEALTH" | grep -q '"ok"'; then
  info "OpenViking 服务正常 ✓"
else
  error "OpenViking 健康检查失败"
fi

# ── 6. 初始化 VikingFS 目录 ───────────────────────────────
step "Step 6: 初始化 VikingFS 目录结构"

DIRS=(
  "viking://agent/config"
  "viking://user/memories/facts"
  "viking://user/memories/preferences"
  "viking://user/memories/procedures"
  "viking://user/memories/episodic"
  "viking://user/memories/semantic"
  "viking://user/memories/meta"
  "viking://user/resources"
  "viking://sessions"
)

CREATED=0
EXISTED=0
for dir in "${DIRS[@]}"; do
  RESULT=$(curl -sf -X POST "http://127.0.0.1:${OV_PORT}/api/v1/fs/mkdir" \
    -H 'Content-Type: application/json' \
    -d "{\"uri\": \"$dir\"}" 2>/dev/null || echo '{"status":"error"}')

  if echo "$RESULT" | grep -q '"ok"'; then
    CREATED=$((CREATED + 1))
  else
    EXISTED=$((EXISTED + 1))
  fi
done

info "目录创建: ${CREATED} 新建, ${EXISTED} 已存在"

# 验证目录树
info "VikingFS 目录树:"
curl -sf "http://127.0.0.1:${OV_PORT}/api/v1/fs/tree?uri=viking://&depth=2" 2>/dev/null \
  | $PYTHON -c "
import json, sys
try:
    data = json.load(sys.stdin)
    for item in data.get('result', []):
        prefix = '  📁 ' if item.get('isDir') else '  📄 '
        print(f\"{prefix}{item['rel_path']}\")
except: pass
" 2>/dev/null || warn "无法获取目录树 (非关键错误)"

# ── 7. 更新 .env ─────────────────────────────────────────
step "Step 7: 检查项目 .env 配置"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_ROOT/.env"

if [ -f "$ENV_FILE" ]; then
  NEED_UPDATE=false

  if ! grep -q '^OPENVIKING_URL=' "$ENV_FILE"; then
    echo "" >> "$ENV_FILE"
    echo "# ── OpenViking (记忆系统后端) ──────────────────────────────" >> "$ENV_FILE"
    echo "OPENVIKING_URL=http://localhost:${OV_PORT}" >> "$ENV_FILE"
    NEED_UPDATE=true
    info "已添加 OPENVIKING_URL 到 .env"
  fi

  if ! grep -q '^VOLCENGINE_API_KEY=' "$ENV_FILE"; then
    echo "VOLCENGINE_API_KEY=$VOLCENGINE_API_KEY" >> "$ENV_FILE"
    NEED_UPDATE=true
    info "已添加 VOLCENGINE_API_KEY 到 .env"
  fi

  if [ "$NEED_UPDATE" = false ]; then
    info ".env 已包含所需配置 ✓"
  fi
else
  warn ".env 不存在，跳过 (请手动添加 OPENVIKING_URL 和 VOLCENGINE_API_KEY)"
fi

# ── 完成 ──────────────────────────────────────────────────
step "部署完成"

echo ""
info "OpenViking 环境已就绪:"
info "  服务地址:  http://127.0.0.1:${OV_PORT}"
info "  配置文件:  $OV_CONF_FILE"
info "  日志文件:  /tmp/openviking-server.log"
info "  agfs 二进制: $AGFS_BIN"
echo ""
info "常用命令:"
info "  健康检查:  curl http://localhost:${OV_PORT}/health"
info "  查看目录:  curl 'http://localhost:${OV_PORT}/api/v1/fs/tree?uri=viking://&depth=3'"
info "  停止服务:  kill \$(lsof -ti:${OV_PORT})"
info "  查看日志:  tail -f /tmp/openviking-server.log"
echo ""
info "用 PM2 管理 (推荐):"
info "  pm2 start ecosystem.config.js"
echo ""
