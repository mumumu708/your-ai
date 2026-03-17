---
name: rss-digest
description: |
  技术日报生成器 — 从 HN Top 100 博客 + AI 资讯源 + GitHub Trending 抓取 RSS，经 AI 评分、分类、摘要、翻译后生成结构化全中文技术日报。

  当用户提到以下场景时触发此 Skill：
  - 生成技术日报、RSS 日报、每日技术资讯
  - 抓取 RSS 源并生成摘要/报告
  - 获取 Hacker News 热门博客的最新文章
  - 技术文章自动分类、评分、摘要
  - 订阅技术博客并生成中文摘要
  - "帮我看看今天技术圈有什么新闻"
  - "生成一份技术日报"
  - "抓取 RSS 源"
  - "技术资讯汇总"
  即使用户没有明确提到 RSS，只要涉及批量获取技术文章、生成技术摘要报告、技术趋势分析，都应触发此 Skill。
---

# RSS Tech Digest — 技术日报生成器

## 架构概述

本 Skill 采用 **脚本 + Agent 协作** 的分层架构：

- **脚本层**（`scripts/rss-digest.ts`）：RSS 抓取、XML 解析、时间过滤、去重、规则预评分，输出候选文章 JSON
- **Agent 层**（本文档描述的流程）：AI 评分、分类、中文摘要、趋势总结
- **渲染层**（`scripts/render-digest.py`）：纯模板引擎，读取 JSON 数据 → 输出 Markdown 日报

脚本不调用任何 AI API。排版渲染不调用 AI。所有智能处理由 Agent 自身完成。

---

## 执行流水线

收到用户请求后，按以下 **4 步** 顺序执行：

### Step 1: RSS 抓取 + 预过滤

运行脚本获取原始文章并通过规则预评分筛选候选文章：

```bash
SKILL_PATH="<skill-path>"
# 优先用 bun，fallback 到 npx tsx
if command -v bun &>/dev/null; then
  RUNNER="bun run"
elif command -v npx &>/dev/null; then
  RUNNER="npx tsx"
else
  echo "❌ 需要 bun 或 Node.js 18+ 环境" && exit 1
fi
$RUNNER "$SKILL_PATH/scripts/rss-digest.ts" --hours <N> --top <M> --output articles.json
```

参数说明：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--hours` | 时间窗口（小时） | 48 |
| `--top` | 预评分后保留的候选文章数 | 80 |
| `--output` | 输出 JSON 文件路径 | stdout |
| `--concurrency` | 并发抓取数 | 10 |
| `--timeout` | 单源超时（ms） | 15000 |
| `--min-desc-length` | 最短描述长度，过滤纯链接 | 60 |

脚本输出 JSON 结构：

```json
{
  "totalFeeds": 244,
  "successFeeds": 220,
  "failedFeeds": 24,
  "totalArticles": 9394,
  "filteredByTime": 358,
  "filteredByPreScore": 80,
  "hoursWindow": 48,
  "fetchedAt": "2026-01-01T12:00:00Z",
  "articles": [
    {
      "title": "Article title",
      "link": "https://...",
      "pubDate": "2026-01-01T10:00:00Z",
      "pubDateRelative": "2 小时前",
      "description": "Plain text excerpt...",
      "source": "simonwillison.net",
      "preScore": 12
    }
  ]
}
```

脚本已按 preScore 降序排列。进度日志走 stderr，JSON 走 stdout 或文件。

---

### Step 2: AI 评分 + 分类 + 摘要（两阶段合并）

读取 articles.json，执行两阶段处理。**所有文本输出使用中文。**

#### 阶段 A — 全量评分

对所有候选文章（通常 ≤80 篇）进行评分和分类。每批处理 **20 篇**。

对每篇文章从三个维度打分（1-10）：

| 维度 | 说明 |
|------|------|
| relevance | 对软件工程师和技术从业者的相关度 |
| quality | 内容深度、洞察力、技术含量（纯链接/转发/碎片信息给低分） |
| timeliness | 话题的新闻性和及时性 |

同时将每篇文章归入以下 **6 大分类** 之一：

| 分类 | Emoji | 覆盖范围 |
|------|-------|----------|
| AI / ML | 🤖 | AI、机器学习、LLM、深度学习 |
| Security | 🔒 | 安全、隐私、漏洞、加密 |
| Engineering | ⚙️ | 软件工程、架构、编程语言、系统设计 |
| Tools / Open Source | 🛠 | 开发工具、开源项目、新发布的库/框架 |
| Opinion / Misc | 💡 | 行业观点、个人思考、职业发展 |
| Other | 📝 | 不属于以上分类的内容 |

为每篇文章提取 **2-4 个中文关键词**。

#### 阶段 B — Top N 摘要

阶段 A 完成后，按 `totalScore = relevance + quality + timeliness` 降序排列，取 **Top N**（默认 15，用户可指定）生成：

- **chineseTitle**：中文标题（自然流畅，非逐字翻译；中文原标题直接使用）
- **summary**：**中文**结构化摘要（4-6 句），覆盖：核心问题 → 关键论点/发现 → 结论/影响
- **recommendation**：1-2 句**中文**推荐理由

#### 输出格式（严格约束）

阶段 A + B 的结果合并写入 **一个** JSON 文件 `scored.json`。

格式为**扁平数组**，禁止嵌套包裹。每个元素结构如下：

```json
[
  {
    "title": "原标题",
    "link": "https://...",
    "source": "simonwillison.net",
    "pubDate": "2026-01-01T10:00:00Z",
    "pubDateRelative": "2 小时前",
    "description": "原始描述",
    "relevance": 8,
    "quality": 7,
    "timeliness": 9,
    "totalScore": 24,
    "category": "AI / ML",
    "keywords": ["AI Agent", "调试框架"],
    "chineseTitle": "微软推出 AgentRx：AI Agent 系统化调试框架",
    "summary": "微软研究院发布了 AgentRx 框架...",
    "recommendation": "对于正在构建 AI Agent 的团队..."
  }
]
```

**格式硬约束（违反视为 Bug）**：
1. 顶层必须是 JSON 数组 `[...]`，禁止 `{"articles": [...]}`、`{"batch": ...}` 等包裹
2. 评分字段 `relevance`、`quality`、`timeliness`、`totalScore` 直接平铺，禁止嵌套为 `scores` 或 `score` 对象
3. `totalScore` 必须等于 `relevance + quality + timeliness`
4. Top N 之外的文章没有 `chineseTitle`、`summary`、`recommendation` 字段
5. `keywords` 为中文关键词数组
6. 所有文章按 `totalScore` 降序排列

**处理流程**：

1. 读取 articles.json 中的 articles 数组
2. 分批（每批 20 篇）评分，将每批结果追加到内存数组中
3. 全部评完后排序，对 Top N 在同一次处理中生成摘要
4. 将完整数组一次性写入 `scored.json`

---

### Step 3: 趋势总结

基于 scored.json 中的 Top N 文章，用**中文**归纳：

```json
{
  "highlights": "3-5 句话的宏观趋势总结段落",
  "trends": [
    {
      "title": "趋势标题",
      "description": "趋势简要描述"
    }
  ]
}
```

- `highlights`：用一段话总结今天技术圈的宏观动向
- `trends`：2-4 个具体趋势，每个包含标题和描述

将结果写入 `trends.json`。

---

### Step 4: 排版渲染

使用 Python 脚本将数据组装为 Markdown 日报：

```bash
python3 "$SKILL_PATH/scripts/render-digest.py" \
  --articles articles.json \
  --scored scored.json \
  --trends trends.json \
  --output "tech-digest-$(date +%Y-%m-%d).md" \
  --min-score 15
```

参数说明：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--articles` | Step 1 的原始抓取数据 | 必填 |
| `--scored` | Step 2 的评分结果 | 必填 |
| `--trends` | Step 3 的趋势总结 | 必填 |
| `--output` | 输出 Markdown 文件路径 | 必填 |
| `--min-score` | 分类列表最低显示分数 | 15 |
| `--top-n` | 今日必读篇数 | 3 |

脚本自动生成以下板块：

| 板块 | 内容 |
|------|------|
| 📝 今日看点 | 宏观趋势总结 + 趋势洞察 |
| 🏆 今日必读 | Top 3 深度展示（中文标题、摘要、推荐理由、关键词） |
| 📊 数据概览 | 统计表格 + Mermaid 饼图 + ASCII 柱状图 + 标签云 |
| 分类文章列表 | 按 6 大分类分组，Top N 展示摘要，其余只展示标题+评分 |

---

## 输出与交付

日报生成后：

1. 将完整 Markdown 内容保存为文件 `tech-digest-{YYYY-MM-DD}.md`
2. 将文件上传供用户下载
3. 向用户展示日报的 **"今日看点"** 和 **"今日必读"** 部分作为预览
4. 如果用户要求上传飞书，使用 upload_to_feishu_tool 工具上传

---

## 数据源

244 个 RSS 源，涵盖：

- **HN Popularity Contest Top 100**：Hacker News 最受欢迎个人博客
- **AI 资讯聚合**：CloudFlare AI Insight Daily、smol.ai News
- **GitHub Trending**：每日热门开源项目
- **中文技术博客**：量子位、爱范儿、阮一峰、美团技术等
- **中文 Twitter 博主**：15 位活跃技术博主
- **AI 公司官方**：OpenAI、Anthropic、Google、Meta、NVIDIA、Cursor 等
- **华人 AI 研究者**：李飞飞、吴恩达、Jerry Liu 等
- **微信公众号**：机器之心、新智元、36氪等 53 个公众号

完整源列表见 `scripts/rss-digest.ts` 中的 `RSS_FEEDS` 数组。

---

## 用户可调参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| 时间窗口 | 只看最近 N 小时的文章 | 48 小时 |
| Top N | 生成详细摘要的文章数 | 15 |
| 候选池 | 预评分保留的候选文章数 | 80 |
| 最低展示分 | 分类列表最低显示分数 | 15/30 |
| 输出格式 | Markdown / 飞书文档 | Markdown |
| 关注领域 | 侧重某些分类的评分权重 | 无偏好（均衡） |

---

## 注意事项

- 脚本兼容 Bun 和 Node.js 18+（通过 npx tsx），优先使用 Bun
- 脚本的进度日志走 stderr，不会污染 JSON 数据输出
- 文章不足 5 篇时脚本会自动扩大时间窗口
- `--min-desc-length` 过滤纯链接推文，提高信噪比
- 排版脚本为纯 Python（零依赖），不需要 AI 调用
- **所有面向用户的文本输出为中文**（摘要、标题翻译、推荐理由、趋势总结、关键词）
