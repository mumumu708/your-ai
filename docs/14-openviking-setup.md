# OpenViking 环境部署指南

> 记录部署 OpenViking 记忆系统后端过程中遇到的坑和解决方案，供后续在其他环境部署时参考。

## 目录

- [架构概览](#架构概览)
- [前置要求](#前置要求)
- [一键部署](#一键部署)
- [手动部署步骤](#手动部署步骤)
- [踩坑记录](#踩坑记录)
- [API 端点参考](#api-端点参考)
- [故障排查](#故障排查)

---

## 架构概览

```
┌─────────────────────────────────────────────────────┐
│  your-ai Gateway  (Bun / port 3000)                 │
│    └── CentralController                            │
│          ├── OpenVikingClient  ──HTTP──┐             │
│          ├── ConfigLoader (local-first)│             │
│          └── KnowledgeRouter           │             │
└────────────────────────────────────────│─────────────┘
                                         │
┌────────────────────────────────────────▼─────────────┐
│  OpenViking Server  (Python/uvicorn / port 1933)     │
│    ├── FastAPI HTTP 层                               │
│    ├── VikingDB (本地向量库)                          │
│    └── AGFS Server (Go 编译的二进制子进程 / port 1833)│
│         └── VikingFS 虚拟文件系统                     │
└──────────────────────────────────────────────────────┘
```

关键点：OpenViking Server 是 Python 应用，但它内部启动了一个 **Go 编译的 agfs-server 子进程**。这个二进制文件是部署踩坑的主要来源。

---

## 前置要求

| 依赖 | 最低版本 | 用途 |
|------|---------|------|
| Python | 3.10+ | OpenViking Server 运行时 |
| Go | 1.21+ | 编译 agfs-server（仅在二进制不兼容时需要） |
| pip | - | 安装 openviking 包 |
| curl | - | 健康检查和 API 调用 |
| git | - | 克隆 OpenViking 源码（编译 agfs-server 时需要） |

### 火山引擎 API Key

OpenViking 使用火山引擎的 VLM 和 Embedding 模型，需要：
- `VOLCENGINE_API_KEY` — 通过 [火山引擎控制台](https://console.volcengine.com/) 获取
- VLM 模型: `doubao-seed-1-8-251228`（记忆分析与进化）
- Embedding 模型: `doubao-embedding-vision-250615`（向量化，1024维）

---

## 一键部署

```bash
# 设置 API Key
export VOLCENGINE_API_KEY=your-key-here

# 运行部署脚本
./scripts/setup-openviking.sh
```

脚本会自动完成以下所有步骤，包括检测并修复 agfs-server 二进制兼容性问题。

---

## 手动部署步骤

### Step 1: 安装 OpenViking Python 包

```bash
pip install openviking --upgrade
```

验证安装：
```bash
python3 -c "import openviking; print(openviking.__version__)"
# 应输出 0.2.3 或更高
```

### Step 2: 检查 agfs-server 二进制兼容性

**这是最容易踩坑的一步。** OpenViking pip 包中捆绑了一个预编译的 `agfs-server` 二进制，但 **可能与当前平台不兼容**。

找到二进制位置：
```bash
python3 -c "import openviking, os; print(os.path.join(os.path.dirname(openviking.__file__), 'bin', 'agfs-server'))"
```

检查二进制架构：
```bash
file $(python3 -c "import openviking, os; print(os.path.join(os.path.dirname(openviking.__file__), 'bin', 'agfs-server'))")
```

**期望结果：**
| 平台 | 期望输出 |
|------|---------|
| macOS ARM64 (M1/M2/M3) | `Mach-O 64-bit executable arm64` |
| macOS Intel | `Mach-O 64-bit executable x86_64` |
| Linux x86_64 | `ELF 64-bit LSB executable, x86-64` |
| Linux aarch64 | `ELF 64-bit LSB executable, ARM aarch64` |

**如果不匹配**，需要从源码编译（见 Step 3）。

### Step 3: 从源码编译 agfs-server（仅在不兼容时）

```bash
# 确保 Go 1.21+ 已安装
go version  # 或安装: brew install go (macOS) / 从 go.dev/dl 下载 (Linux)

# 克隆源码
git clone --depth 1 https://github.com/volcengine/OpenViking.git /tmp/openviking-src

# 编译
cd /tmp/openviking-src/third_party/agfs/agfs-server
make build

# 验证
file build/agfs-server

# 备份并替换
AGFS_BIN=$(python3 -c "import openviking, os; print(os.path.join(os.path.dirname(openviking.__file__), 'bin', 'agfs-server'))")
cp "$AGFS_BIN" "${AGFS_BIN}.bak"
cp build/agfs-server "$AGFS_BIN"
chmod +x "$AGFS_BIN"

# 清理
rm -rf /tmp/openviking-src
```

### Step 4: 生成配置文件

```bash
mkdir -p ~/.openviking

cat > ~/.openviking/ov.conf << 'EOF'
{
  "vlm": {
    "provider": "volcengine",
    "api_key": "YOUR_VOLCENGINE_API_KEY",
    "model": "doubao-seed-1-8-251228",
    "api_base": "https://ark.cn-beijing.volces.com/api/v3",
    "temperature": 0.1,
    "max_retries": 3
  },
  "embedding": {
    "dense": {
      "provider": "volcengine",
      "api_key": "YOUR_VOLCENGINE_API_KEY",
      "model": "doubao-embedding-vision-250615",
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
    "port": 1933
  }
}
EOF
```

> 注意 `storage.workspace` 是相对路径，相对于 **openviking-server 启动目录**。建议在项目根目录下启动，数据会保存在 `./openviking-data/`。

### Step 5: 启动 OpenViking Server

```bash
# 前台启动（调试用）
openviking-server --config ~/.openviking/ov.conf

# 后台启动
nohup openviking-server --config ~/.openviking/ov.conf > /tmp/openviking-server.log 2>&1 &

# 用 PM2 管理（推荐生产用法）
pm2 start ecosystem.config.js
```

验证：
```bash
# 健康检查
curl http://localhost:1933/health
# {"status":"ok"}

# 就绪检查
curl http://localhost:1933/ready
# {"status":"ready","checks":{"agfs":"ok","vectordb":"ok",...}}
```

### Step 6: 初始化 VikingFS 目录结构

```bash
# 方式 A: 用项目自带脚本
bun run src/setup/init-viking-dirs.ts

# 方式 B: 手动 curl
for dir in \
  "viking://agent/config" \
  "viking://user/memories/facts" \
  "viking://user/memories/preferences" \
  "viking://user/memories/procedures" \
  "viking://user/memories/episodic" \
  "viking://user/memories/semantic" \
  "viking://user/memories/meta" \
  "viking://user/resources" \
  "viking://sessions"; do
  curl -s -X POST http://localhost:1933/api/v1/fs/mkdir \
    -H 'Content-Type: application/json' \
    -d "{\"uri\": \"$dir\"}"
done
```

验证目录树：
```bash
curl -s 'http://localhost:1933/api/v1/fs/tree?uri=viking://&depth=3'
```

### Step 7: 配置 .env

在项目 `.env` 中添加：
```bash
OPENVIKING_URL=http://localhost:1933
VOLCENGINE_API_KEY=your-key-here
```

---

## 踩坑记录

### 坑 1: agfs-server 架构不匹配（严重）

**现象：** `openviking-server` 启动后立即报错：
```
OSError: [Errno 8] Exec format error: '.../openviking/bin/agfs-server'
```

**原因：** pip 安装的 OpenViking 包中捆绑的 `agfs-server` 二进制是 Linux x86-64 ELF 格式，但当前机器是 macOS ARM64 (Apple Silicon)。

**根因：** OpenViking v0.2.3 的 PyPI 发布包只包含了 Linux x86-64 的 agfs-server 预编译二进制，没有为 macOS 或其他架构提供对应版本。

**解决：** 从 [GitHub 源码](https://github.com/volcengine/OpenViking) 编译 agfs-server：
```bash
cd /path/to/OpenViking/third_party/agfs/agfs-server
make build   # 需要 Go 1.21+
# 然后替换 pip 包中的二进制
```

**注意：** `pip install --upgrade openviking` 会覆盖回 Linux 二进制！升级后需要重新替换。

### 坑 2: VectorDB 锁文件残留

**现象：**
```
IO error: lock .../openviking-data/vectordb/memory_context/store/LOCK: Resource temporarily unavailable
```

**原因：** 之前的 OpenViking 进程非正常退出，锁文件未清理。

**解决：**
```bash
# 先确保没有旧进程
kill $(lsof -ti:1933) 2>/dev/null
# 删除锁文件
rm -f openviking-data/vectordb/memory_context/store/LOCK
```

### 坑 3: 端口冲突

**现象：**
```
[Errno 48] error while attempting to bind on address ('127.0.0.1', 1933): address already in use
```

**解决：**
```bash
# 找到占用端口的进程
lsof -ti:1933
# 杀掉
kill $(lsof -ti:1933)
```

### 坑 4: OpenViking Client API 路径不一致

开发 `OpenVikingClient` 时，以下端点路径与实际 API 不一致，已在代码中修复：

| 功能 | 错误路径 | 正确路径 |
|------|---------|---------|
| 系统状态 | `GET /api/v1/status` | `GET /api/v1/system/status` |
| 内容摘要 | `GET /api/v1/fs/abstract` | `GET /api/v1/content/abstract` |
| 内容概览 | `GET /api/v1/fs/overview` | `GET /api/v1/content/overview` |
| 内容读取 | `GET /api/v1/fs/read` | `GET /api/v1/content/read` |
| 创建关联 | `POST /api/v1/fs/link` | `POST /api/v1/relations/link` |
| 查询关联 | `GET /api/v1/fs/relations` | `GET /api/v1/relations` |
| 删除关联 | `POST /api/v1/fs/unlink` | `DELETE /api/v1/relations/link` |

### 坑 5: find/search 返回格式

**现象：** `Spread syntax requires ...iterable[Symbol.iterator] to be a function`

**原因：** `POST /api/v1/search/find` 返回的不是数组，而是分类对象：
```json
{
  "memories": [...],
  "resources": [...],
  "skills": [...],
  "total": 0
}
```

**解决：** 在 client 层 flatten：
```typescript
const resp = await this.request<FindResponse>('POST', '/api/v1/search/find', ...);
return [...(resp.memories ?? []), ...(resp.resources ?? []), ...(resp.skills ?? [])];
```

### 坑 6: /health 和 /ready 不使用标准 OVResponse 包装

`/health` 和 `/ready` 端点返回的格式与 `/api/v1/...` 端点不同：

```
GET /health  → {"status":"ok"}                                          (无 result/error 包装)
GET /ready   → {"status":"ready","checks":{"agfs":"ok","vectordb":"ok"}} (无 result/error 包装)
GET /api/v1/system/status → {"status":"ok","result":{...},"error":null}  (标准 OVResponse)
```

需要用单独的 `requestRaw()` 方法处理 `/health` 和 `/ready`。

### 坑 7: resources API 只接受 resources 作用域

```bash
# 这样会报错（target 不在 resources 作用域）:
curl -X POST /api/v1/resources -d '{"path": "...", "target": "viking://agent/config/..."}'
# → "add_resource only supports resources scope"

# 正确用法（不指定 target，自动放到 viking://resources/）:
curl -X POST /api/v1/resources -d '{"path": "/local/file.md"}'
```

用户记忆（`viking://user/memories/`）不能通过 resources API 写入，只能通过 session → commit 流程自动提取。

### 坑 8: storage.workspace 是相对路径

`ov.conf` 中的 `storage.workspace` 是相对于 **openviking-server 启动时的工作目录** 的。如果配置为 `"./openviking-data"`，数据会保存在 `$PWD/openviking-data/`。

用 PM2 启动时，工作目录默认是 `ecosystem.config.js` 所在目录（即项目根目录），所以数据会在项目根目录下。

### 坑 9: 修改 `.env` 后 `pm2 restart` 不刷新 ov.conf

PM2 启动 `openviking-server` 前，`ecosystem.config.cjs` 顶层会 `execFileSync` 调用 `src/setup/generate-ov-conf.ts` 读取 `.env` 重新生成 `~/.openviking/ov.conf`。但这段逻辑**只在 PM2 读取 ecosystem 文件时执行一次**。

```bash
# ❌ 不会刷新 ov.conf（PM2 用缓存的 app 配置）
pm2 restart openviking-server

# ✅ 必须这样（强制重新加载 ecosystem.config.cjs）
pm2 delete openviking-server && pm2 start ecosystem.config.cjs --only openviking-server

# ✅ 或者重启全部
pm2 restart ecosystem.config.cjs
```

可改的 env 变量：`VOLCENGINE_API_KEY` / `OV_VLM_MODEL` / `OV_EMBEDDING_MODEL`。其他字段（`api_base`、`port` 等）目前硬编码在 `src/setup/generate-ov-conf.ts`，需改代码。

#### 为什么 conf 生成没做成 PM2 app

最初实现是加一个 `ov-conf-gen` PM2 app（`autorestart: false` 跑一次就退），但 PM2 的 `require-in-the-middle` 插桩跟 bun 跑带 top-level `await` 的 TS 文件不兼容，会报：

```
TypeError: require() async module "...generate-ov-conf.ts" is unsupported.
use "await import()" instead.
```

改成在 `ecosystem.config.cjs` 顶层 `execFileSync` 同步执行即可绕开。

---

## API 端点参考

完整列表可通过 `curl http://localhost:1933/openapi.json` 获取。常用端点：

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查 |
| `GET` | `/ready` | 就绪检查（含各组件状态） |
| `GET` | `/api/v1/system/status` | 系统状态（初始化状态、用户） |
| `POST` | `/api/v1/system/wait` | 等待所有队列处理完成 |
| `POST` | `/api/v1/fs/mkdir` | 创建 VikingFS 目录 |
| `GET` | `/api/v1/fs/ls?uri=...` | 列出目录内容 |
| `GET` | `/api/v1/fs/tree?uri=...&depth=N` | 目录树 |
| `GET` | `/api/v1/fs/stat?uri=...` | 文件/目录详情 |
| `DELETE` | `/api/v1/fs?uri=...` | 删除文件/目录 |
| `POST` | `/api/v1/fs/mv` | 移动/重命名 |
| `GET` | `/api/v1/content/abstract?uri=...` | 内容摘要 (L0) |
| `GET` | `/api/v1/content/overview?uri=...` | 内容概览 (L1) |
| `GET` | `/api/v1/content/read?uri=...` | 完整内容 (L2) |
| `POST` | `/api/v1/resources` | 添加资源文件 |
| `POST` | `/api/v1/search/find` | 语义搜索 |
| `POST` | `/api/v1/search/search` | 全文搜索 |
| `POST` | `/api/v1/search/grep` | 模式搜索 |
| `POST` | `/api/v1/relations/link` | 创建资源关联 |
| `GET` | `/api/v1/relations?uri=...` | 查询关联 |
| `DELETE` | `/api/v1/relations/link` | 删除关联 |
| `POST` | `/api/v1/sessions` | 创建会话 |
| `GET` | `/api/v1/sessions` | 列出会话 |
| `POST` | `/api/v1/sessions/{id}/messages` | 添加消息 |
| `POST` | `/api/v1/sessions/{id}/commit` | 提交会话（触发记忆提取） |

---

## 故障排查

### 服务启动失败

```bash
# 1. 查看详细日志
openviking-server --config ~/.openviking/ov.conf  # 前台运行看输出

# 2. 检查 agfs-server 二进制
file $(python3 -c "import openviking,os; print(os.path.join(os.path.dirname(openviking.__file__),'bin','agfs-server'))")

# 3. 检查端口
lsof -i:1933
lsof -i:1833  # agfs-server 的端口

# 4. 清理锁文件
rm -f openviking-data/vectordb/memory_context/store/LOCK
```

### 记忆检索返回空

```bash
# 1. 检查是否有数据
curl -s 'http://localhost:1933/api/v1/fs/tree?uri=viking://user/memories&depth=2'

# 2. 手动搜索测试
curl -s -X POST http://localhost:1933/api/v1/search/find \
  -H 'Content-Type: application/json' \
  -d '{"query": "test", "target_uri": "viking://", "limit": 10}'

# 3. 检查 embedding 是否正常
curl -s http://localhost:1933/api/v1/observer/vikingdb
```

### pip 升级后 agfs-server 被覆盖

```bash
# pip 升级会覆盖回不兼容的二进制
pip install --upgrade openviking

# 需要重新替换（如果之前做了编译替换）
# 建议把编译好的 agfs-server 保存到项目外的稳定位置
cp /path/to/compiled/agfs-server $(python3 -c "import openviking,os; print(os.path.join(os.path.dirname(openviking.__file__),'bin','agfs-server'))")
```

---

## 附录: 完整部署清单

- [ ] Python 3.10+ 已安装
- [ ] `pip install openviking` 成功
- [ ] `agfs-server` 二进制架构与当前平台匹配（`file` 检查）
- [ ] `~/.openviking/ov.conf` 已生成，API Key 已填入
- [ ] `openviking-server` 可以启动且 `/health` 返回 `{"status":"ok"}`
- [ ] `/ready` 返回 `{"status":"ready"}`
- [ ] VikingFS 目录结构已初始化（`/api/v1/fs/tree` 可查看）
- [ ] `.env` 中 `OPENVIKING_URL` 和 `VOLCENGINE_API_KEY` 已配置
- [ ] Gateway 启动后可正常处理消息（`POST /api/messages`）
