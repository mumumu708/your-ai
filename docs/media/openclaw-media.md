## OpenClaw 图片/视频/音频 接收与处理机制调研

基于 `src/` 目录下的核心源码分析，OpenClaw 的多媒体处理涉及三个主要层：**媒体基础层**（`src/media/`）、**媒体理解层**（`src/media-understanding/`）、**语音合成层**（`src/tts/`）。

---

### 一、架构总览

| 层级           | 目录                       | 职责                                                                      |
| -------------- | -------------------------- | ------------------------------------------------------------------------- |
| **媒体基础层** | `src/media/`               | MIME 检测、远程下载、本地存储、HTTP 服务、图片操作、Base64 处理、输出解析 |
| **媒体理解层** | `src/media-understanding/` | 图片描述、音频转录、视频描述；对接多个 AI Provider                        |
| **语音合成层** | `src/tts/`                 | 文本转语音（ElevenLabs、OpenAI、Edge TTS）                                |
| **通道层**     | `src/channels/`            | 统一消息入口，多渠道（Telegram/Discord/Slack/WhatsApp/Web）附件收发       |

数据流向为：**Channel 入站 → Media 存储/下载 → Media-Understanding 理解 → 注入上下文 → Agent 处理 → Media 出站解析 → Channel 出站**。

---

### 二、媒体基础层 (`src/media/`)

#### 2.1 MIME 检测 (`mime.ts`)

采用**三层 MIME 判定策略**，优先级由高到低：

1. **Magic bytes 嗅探**：使用 `file-type` 库对 Buffer 头部字节做二进制嗅探
2. **文件扩展名映射**：`MIME_BY_EXT` / `EXT_BY_MIME` 双向映射表
3. **HTTP Header Content-Type**：作为最低优先级兜底

```typescript
// 核心策略：sniffed > extMime > headerMime
if (sniffed && (!isGenericMime(sniffed) || !extMime)) return sniffed;
if (extMime) return extMime;
if (headerMime && !isGenericMime(headerMime)) return headerMime;
```

特殊处理：当嗅探结果为泛型 MIME（如 `application/octet-stream`、`application/zip`）时，优先采用扩展名映射结果（避免 XLSX 被误判为 ZIP）。

#### 2.2 媒体类型分类 (`constants.ts`)

定义四类 `MediaKind` 及各自大小上限：

| MediaKind  | 最大字节数 | MIME 前缀                                    |
| ---------- | ---------- | -------------------------------------------- |
| `image`    | 6 MB       | `image/*`                                    |
| `audio`    | 16 MB      | `audio/*`                                    |
| `video`    | 16 MB      | `video/*`                                    |
| `document` | 100 MB     | `application/pdf`、`text/*`、`application/*` |

#### 2.3 远程媒体下载 (`fetch.ts`)

`fetchRemoteMedia()` 是远程媒体获取的核心入口：

- **SSRF 防护**：通过 `fetchWithSsrFGuard` 进行严格的 SSRF 防护（DNS 解析锁定、私有网络拦截）
- **流量限制**：`readResponseWithLimit()` 对 Response Body 进行流式读取，超过 `maxBytes` 立即中止
- **读取空闲超时**：`readIdleTimeoutMs` 防止慢读攻击
- **IPv4 回退**：对 Telegram 等平台支持 `fallbackDispatcherPolicy`，主请求失败时自动回退 IPv4
- **文件名解析**：按优先级从 `Content-Disposition` → URL pathname → `filePathHint` 提取文件名
- **自定义错误码**：`MediaFetchError` 携带 `max_bytes`、`http_error`、`fetch_failed` 三种错误码

#### 2.4 本地存储 (`store.ts`)

`saveMediaSource()` / `saveMediaBuffer()` 负责媒体持久化：

- **存储位置**：`~/.openclaw/media/` 目录，支持子目录（如 `inbound`）
- **文件命名**：`{sanitizedOriginal}---{uuid}.{ext}` 格式，兼具可读性和唯一性
- **文件权限**：`0o644`（允许 Docker sandbox 容器读取），目录权限 `0o700`
- **URL 下载**：`downloadToFile()` 使用原生 `node:http/https` 流式写磁盘，前 16KB 抓取用于 MIME 嗅探
- **本地路径读取**：通过 `readLocalFileSafely()` 防止符号链接攻击（TOCTOU 防护）
- **自动清理**：默认 TTL 2 分钟，`cleanOldMedia()` 支持递归清理和空目录剪枝

#### 2.5 HTTP 媒体服务 (`server.ts`)

通过 Express 挂载 `/media/:id` 路由，供渠道回调：

- **路径验证**：严格的 `MEDIA_ID_PATTERN`（仅允许字母数字 + `.` `-` `_`），防止目录穿越
- **沙箱隔离**：`readFileWithinRoot()` 确保读取不会逃逸出 media 目录
- **安全头**：设置 `X-Content-Type-Options: nosniff`
- **过期清理**：请求时检查 TTL，过期直接 410；响应完成后 50ms 延迟删除文件

#### 2.6 音频处理 (`audio.ts`)

专门处理 Telegram 语音消息兼容性：

- 支持的语音 MIME：`audio/ogg`、`audio/opus`、`audio/mpeg`、`audio/mp3`、`audio/mp4`、`audio/x-m4a`、`audio/m4a`
- `isTelegramVoiceCompatibleAudio()` 同时检查 MIME 和文件扩展名

#### 2.7 图片操作 (`image-ops.ts`)

支持 **sharp（跨平台）** 和 **sips（macOS 原生）** 双后端：

- **后端选择**：环境变量 `OPENCLAW_IMAGE_BACKEND` 控制；Bun + macOS 默认使用 sips
- **EXIF 方向校正**：手工解析 JPEG EXIF 方向字节（支持 8 种方向变换）
- **JPEG 压缩**：`resizeToJpeg()` 支持最大边长限制 + 质量参数，启用 mozjpeg
- **PNG 优化**：`optimizeImageToPng()` 遍历尺寸 × 压缩级别网格（2048→800 × 6→9），找到最优组合
- **HEIC 转换**：`convertHeicToJpeg()` 自动将 HEIC/HEIF 转为 JPEG
- **透明度检测**：`hasAlphaChannel()` 用于决策选择 PNG 还是 JPEG 路径

#### 2.8 输出文本中的媒体令牌解析 (`parse.ts`)

`splitMediaFromOutput()` 从 Agent 输出文本中提取 `MEDIA:` 令牌：

- 正则 `MEDIA:\s*`?([^\n]+)`?` 匹配，支持反引号包裹
- **Fence 感知**：解析 Markdown 围栏代码块位置，避免从代码块内提取
- 支持 HTTP URL、本地路径（`/`、`./`、`../`、Windows 驱动器）
- 支持 `[[audio_as_voice]]` 标签，标记音频应以语音消息发送
- 返回 `{ text, mediaUrls, mediaUrl, audioAsVoice }`

---

### 三、媒体理解层 (`src/media-understanding/`)

#### 3.1 类型系统 (`types.ts`)

三种理解能力（Capability）对应三种输出类型（Kind）：

| Capability | Kind                  | 请求类型                    | 结果         |
| ---------- | --------------------- | --------------------------- | ------------ |
| `image`    | `image.description`   | `ImageDescriptionRequest`   | 图片描述文本 |
| `audio`    | `audio.transcription` | `AudioTranscriptionRequest` | 音频转写文本 |
| `video`    | `video.description`   | `VideoDescriptionRequest`   | 视频描述文本 |

**Provider 接口**：每个 Provider 通过实现 `transcribeAudio`、`describeImage`、`describeVideo` 三个可选方法注册能力。

#### 3.2 Provider 体系 (`providers/`)

支持 9 个 AI 提供商：

| Provider          | 音频转写   | 图片描述  | 视频描述 |
| ----------------- | ---------- | --------- | -------- |
| **OpenAI**        | ✅ Whisper | ✅ GPT-4o | ✅       |
| **Google/Gemini** | ✅         | ✅        | ✅       |
| **Anthropic**     | -          | ✅ Claude | -        |
| **Deepgram**      | ✅         | -         | -        |
| **Groq**          | ✅ Whisper | ✅        | -        |
| **Mistral**       | -          | ✅        | -        |
| **Moonshot**      | -          | ✅        | -        |
| **Minimax**       | -          | ✅        | -        |
| **ZAI (GLM-4)**   | -          | ✅        | -        |

此外，还支持 **CLI 方式** 调用本地工具：

- `whisper-cli` / `whisper`：本地 Whisper 音频转写
- `sherpa-onnx-offline`：ONNX 离线语音识别
- `gemini` CLI：本地 Gemini 命令行

#### 3.3 运行引擎 (`runner.ts`)

`runCapability()` 是单能力执行入口：

1. **启用检查**：`config.enabled === false` 直接跳过
2. **附件筛选**：`selectAttachments()` 按 MIME 类型筛选对应能力的附件
3. **作用域策略**：`resolveScopeDecision()` 支持按策略（群组/DM/全局）控制
4. **Vision 模型跳过**：如果当前主模型原生支持 vision（如 GPT-4o），则跳过图片理解（图片直接注入上下文）
5. **自动发现模型**：按优先级尝试 Active Model → 配置的 imageModel → Gemini CLI → API Key 探测
6. **容错链式执行**：遍历候选 entries，单个失败跳过继续，记录每次 attempt 的 decision

模型自动发现优先级：

```
Active Model (用户当前选择的)
  → agents.defaults.imageModel 配置
  → Gemini CLI 探测
  → API Key 按优先级探测 (openai > google > anthropic > ...)
```

#### 3.4 理解结果应用 (`apply.ts`)

`applyMediaUnderstanding()` 是整体编排入口：

1. **并发执行**：image、audio、video 三个能力并发运行（`runWithConcurrency`）
2. **音频转写注入**：
   - 转写文本写入 `ctx.Transcript`
   - 替换 `ctx.CommandBody` / `ctx.RawBody`（让 Agent 看到文字而非附件引用）
   - 可选回显转录文本到聊天（`echoTranscript` 配置）
3. **文件提取**：对非图片/音频/视频的附件（PDF、文本、CSV 等），提取文本内容注入上下文
   - 文本编码检测：支持 UTF-8、UTF-16LE/BE、CP1252 等
   - PDF 专项处理：`extractPdfContent()` 提取文字和图片
   - XML 注入防护：`xmlEscapeAttr()` 和 `escapeFileBlockContent()` 防止 XML 注入
4. **上下文组装**：`formatMediaUnderstandingBody()` 将所有理解输出拼入 `ctx.Body`

#### 3.5 输入文件处理 (`input-files.ts`)

`extractImageContentFromSource()` / `extractFileContentFromSource()` 处理 API 层面的输入：

- **Base64 输入**：校验 payload 大小 → 解码 → MIME 检测 → HEIC 自动转 JPEG
- **URL 输入**：SSRF 防护 fetch → 大小限制 → MIME 验证
- **MIME 白名单**：
  - 图片：`image/jpeg`、`image/png`、`image/gif`、`image/webp`、`image/heic`、`image/heif`
  - 文件：`text/plain`、`text/markdown`、`text/html`、`text/csv`、`application/json`、`application/pdf`

---

### 四、语音合成层 (`src/tts/`)

`tts-core.ts` 支持三种 TTS 引擎：

| 引擎           | 调用方式                            | 特点                                                                                               |
| -------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| **OpenAI TTS** | `POST /v1/audio/speech`             | 支持自定义 baseUrl（兼容 Kokoro/LocalAI）；模型：`gpt-4o-mini-tts`、`tts-1`、`tts-1-hd`；14 种语音 |
| **ElevenLabs** | `POST /v1/text-to-speech/{voiceId}` | 支持 voice settings（stability、similarity、style、speed）、语言代码、种子                         |
| **Edge TTS**   | `node-edge-tts` 库                  | 微软 Edge 在线 TTS，支持 rate/pitch/volume/字幕                                                    |

**TTS 指令机制**：Agent 输出中可嵌入 `[[tts:...]]` 指令标签，控制 provider/voice/model/speed 等参数（受策略门控）。

**文本预处理**：长文本自动摘要（`summarizeText()`），通过配置的 LLM 模型将过长文本压缩到 TTS 友好长度。

---

### 五、安全机制

贯穿整个媒体处理流程的安全措施：

| 安全层面          | 措施                                                                                |
| ----------------- | ----------------------------------------------------------------------------------- |
| **SSRF 防护**     | DNS 解析锁定、私有网络拦截、hostname allowlist                                      |
| **路径安全**      | `readLocalFileSafely` TOCTOU 防护、`readFileWithinRoot` 沙箱限制、符号链接拒绝      |
| **MIME 欺骗防护** | `reject spoofed input_image MIME payloads`，三层 MIME 判定互相验证                  |
| **大小限制**      | 多层字节限制（download 层 5MB、input_image 10MB、audio/video 16MB、document 100MB） |
| **注入防护**      | XML 转义、media ID 正则校验、Content-Disposition 解析安全化                         |
| **凭据保护**      | `redactSensitiveText` URL 脱敏、`SecretRef-safe` 持久化                             |
