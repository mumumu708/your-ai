---
name: rss-digest
description: |
  每日要闻生成器 — 从 RSS 订阅源、Product Hunt、GitHub Trending、Google News、播客等多渠道抓取数据，经 AI 评分、分类、摘要、翻译后生成结构化全中文每日要闻报告。

  当用户提到以下场景时触发此 Skill：
  - 生成每日要闻、技术日报、RSS 日报、每日资讯
  - 抓取 RSS 源并生成摘要/报告
  - 获取技术圈 / 产品圈 / 新闻圈的最新动态
  - 技术文章自动分类、评分、摘要
  - "帮我看看今天有什么新闻"
  - "生成一份每日要闻"
  - "今天有什么值得关注的"
  - "技术资讯汇总"
  - "帮我看看 Product Hunt 上有什么新产品"
  - "GitHub Trending 今天有什么"
  即使用户没有明确提到 RSS，只要涉及批量获取资讯、生成摘要报告、趋势分析，都应触发此 Skill。
---

# 每日要闻生成器

## 架构概述

本 Skill 采用 **脚本 + Agent 协作** 的分层架构：

- **脚本层**（`scripts/rss-digest.ts`）：RSS 抓取、XML 解析、时间过滤、去重、规则预评分，输出候选文章 JSON
- **Agent 层**（本文档描述的流程）：web_search / web_fetch 补充抓取、AI 评分、分类、中文摘要、趋势总结
- **渲染层**（`scripts/render-digest.py`）：纯模板引擎，读取 JSON 数据 → 输出 Markdown 每日要闻

脚本不调用任何 AI API。排版渲染不调用 AI。所有智能处理由 Agent 自身完成。

---

## 执行流水线

收到用户请求后，按以下步骤顺序执行：

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
  "totalFeeds": 280,
  "successFeeds": 250,
  "failedFeeds": 30,
  "totalArticles": 10000,
  "filteredByTime": 400,
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
      "sourceCategory": "tech_blog",
      "preScore": 12
    }
  ]
}
```

脚本已按 preScore 降序排列。进度日志走 stderr，JSON 走 stdout 或文件。

---

### Step 2: 抓取 Product Hunt 数据（AI 相关，Top 3–5）

目标：获取今天 Product Hunt 排行榜上 **Top 3–5 的 AI 相关产品**。

1. 使用 `web_fetch` 访问 `https://www.producthunt.com/feed`。
2. 从排行榜中挑选 **Top 3–5 AI 相关产品**（AI 工具、LLM 封装、ML 基础设施、AI Agent、AIGC 等）。如果 AI 相关产品不足 3 个，用排名靠前的非 AI 产品补足，并标注非 AI。
3. 对每个产品收集：
   - 产品名称
   - 一句话标语
   - 点赞数（如有）
   - 产品页面链接：`https://www.producthunt.com/posts/{slug}`
4. 写一句简短点评，说明该产品为何值得关注。

将结果写入 `producthunt.json`：

```json
[
  {
    "name": "产品名称",
    "tagline": "一句话标语",
    "upvotes": 123,
    "link": "https://www.producthunt.com/posts/xxx",
    "isAI": true,
    "note": "简短点评"
  }
]
```

---

### Step 3: 抓取 GitHub Trending 数据（Top 5）

目标：获取 GitHub Trending 每日热门仓库 **Top 5**。

1. 使用 `web_fetch` 访问 `https://github.com/trending?since=daily`。
2. 提取 **Top 5** 仓库信息：
   - 全名（`owner/repo`）
   - 描述
   - 主要语言
   - 总 Star 数
   - 今日新增 Star 数
3. 链接：`https://github.com/{owner}/{repo}`
4. 如果与用户兴趣相关（AI Agent、TypeScript、Python、LangChain、医疗科技等），添加简短相关性说明。

将结果写入 `github-trending.json`：

```json
[
  {
    "name": "owner/repo",
    "description": "仓库描述",
    "language": "Python",
    "stars": 12345,
    "starsToday": 234,
    "link": "https://github.com/owner/repo",
    "note": "相关性说明（可选）"
  }
]
```

---

### Step 4: 抓取新闻与播客

这是最具编辑性的步骤，从多个来源收集新闻，然后严格策展。

#### 4a: Google News — 重大突发新闻

1. 使用 `web_fetch` 访问 `https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans`。
2. 扫描**国内外重大事件**——地缘政治变动、重大政策变化、自然灾害、重大经济事件、里程碑式科技监管等。
3. 只收录真正重大的新闻，跳过日常政治报道和软新闻。

#### 4b: 阿里巴巴 & 字节跳动企业动态

1. 使用 `web_search` 搜索 `阿里巴巴 新闻 today {YYYY-MM-DD}` 或类似时效性查询。
2. 使用 `web_search` 搜索 `字节跳动 新闻 today {YYYY-MM-DD}` 或类似时效性查询。
3. 关注：财报、重大产品发布、人事变动、监管行动、收购、裁员、影响股价的事件。
4. 如无实质性新闻，完全跳过此子章节——不要凑数。

#### 4c: AI 与健康新闻

1. 使用 `web_search` 搜索 `AI coding news today` 和 `AI healthcare latest`（英文）。
2. 关注：FDA 批准的 AI 医疗设备、重大研究突破（如临床数据基础模型）、数字健康 AI 领域的重大融资、监管动态。

#### 4d: 策展规则（必须遵守）

在定稿新闻列表前，严格执行以下过滤：

- **时效性**：事件必须发生在今天或即将发生。不要收录昨天或更早的新闻，除非是隔夜爆发且仍在发展中的。
- **重要性**：用户是否值得被打断来了解这件事？如果不是，跳过。
- **去重**：对照用户近期的要闻产出（使用 `conversation_search` 搜索关键词"要闻"查找近期报告）。不要收录近期要闻中已出现的新闻。如不确定，可收录但标注为发展中的。
- **结果**：各子类别合计 **3–8 条新闻**。宁少勿凑。

#### 4e: 抓取播客更新

1. 使用 `web_fetch` 访问以下播客页面，检查是否有更新：
   - [硅谷101](https://www.xiaoyuzhoufm.com/podcast/5e5c52c9418a84a04625e6cc)
   - [罗永浩的十字路口](https://www.xiaoyuzhoufm.com/podcast/68981df29e7bcd326eb91d88)
   - [十字路口 Crossing](https://www.xiaoyuzhoufm.com/podcast/60502e253c92d4f62c2a9577)
   - [晚点聊](https://www.xiaoyuzhoufm.com/podcast/61933ace1b4320461e91fd55)
   - [elsewhere别处发生](https://www.xiaoyuzhoufm.com/podcast/68ff657d9c745a6e69da8fcf)

2. 只收录最近 48 小时内更新的播客。

将新闻和播客结果写入 `news.json`：

```json
{
  "news": [
    {
      "title": "新闻标题",
      "link": "https://...",
      "source": "来源",
      "category": "breaking / corporate / ai_health",
      "summary": "一句话摘要"
    }
  ],
  "podcasts": [
    {
      "name": "播客名称",
      "episode": "最新一期标题",
      "link": "https://...",
      "summary": "简短描述"
    }
  ]
}
```

---

### Step 5: AI 评分 + 分类 + 摘要（两阶段合并）

读取 articles.json，结合 Step 2–4 的数据，执行两阶段处理。**所有文本输出使用中文。**

#### 阶段 A — 全量评分

对所有候选文章（通常 ≤80 篇）进行评分和分类。每批处理 **20 篇**。

对每篇文章从三个维度打分（1-10）：

| 维度 | 说明 |
|------|------|
| relevance | 对技术从业者和关注时事的专业人士的相关度 |
| quality | 内容深度、洞察力、技术含量（纯链接/转发/碎片信息给低分） |
| timeliness | 话题的新闻性和及时性 |

同时将每篇文章归入以下分类之一：

| 分类 | 覆盖范围 |
|------|----------|
| AI / ML | AI、机器学习、LLM、深度学习 |
| Engineering | 软件工程、架构、编程语言、系统设计 |
| Tools | 开发工具、新发布的库/框架 |
| Security | 安全、隐私、漏洞、加密 |
| Open Source | 开源项目、开源趋势 |
| Product | 产品发布、产品评测、用户体验 |
| News | 时事新闻、行业动态、企业新闻、财经 |
| Other | 不属于以上分类的内容 |

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

### Step 6: 趋势总结

基于 scored.json 中的 Top N 文章，结合 Step 2–4 的数据，用**中文**归纳：

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

- `highlights`：用一段话总结今天的宏观动向（渲染为每日要闻开头的导语）
- `trends`：2-4 个具体趋势，每个包含标题和描述

将结果写入 `trends.json`。

---

### Step 7: 排版渲染

使用 Python 脚本将数据组装为 Markdown 每日要闻：

```bash
python3 "$SKILL_PATH/scripts/render-digest.py" \
  --articles articles.json \
  --scored scored.json \
  --trends trends.json \
  --producthunt producthunt.json \
  --github github-trending.json \
  --news news.json \
  --output "daily-briefing-$(date +%Y-%m-%d).md" \
  --min-score 15
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--articles` | Step 1 的原始抓取数据 | 必填 |
| `--scored` | Step 5 的评分结果 | 必填 |
| `--trends` | Step 6 的趋势总结 | 必填 |
| `--producthunt` | Step 2 的 Product Hunt 数据 | 必填 |
| `--github` | Step 3 的 GitHub Trending 数据 | 必填 |
| `--news` | Step 4 的新闻与播客数据 | 必填 |
| `--output` | 输出 Markdown 文件路径 | 必填 |
| `--min-score` | 分类列表最低显示分数 | 15 |
| `--top-n` | 今日必读篇数 | 5 |

脚本自动生成以下板块：

| 板块 | 内容 |
|------|------|
| 今日必读 | Top N 深度展示（中文标题超链接 + 1-2 句点评） |
| 技术 | 按子分类分组：AI/ML、Engineering、Tools、Security、Open Source |
| 产品速递 | Product Hunt AI 产品 + GitHub Trending 仓库 + RSS 中 Product 分类文章 |
| 新闻资讯 | 重大新闻、企业动态、AI 健康新闻 + RSS 中 News 分类文章 |
| 播客更新 | 最近更新的播客（如有） |
| 其他 | 有价值但不属于以上分类的内容（无则省略） |

---

## 输出格式规范

### Markdown 模板

```markdown
# 每日要闻 | {YYYY-MM-DD}

（趋势导语，如有）

## 今日必读

- [中文标题](链接) — 1-2 句点评。

## 技术

### AI、机器学习、LLM、深度学习

- [中文标题](链接) — 1-2 句点评。

### 软件工程、架构、编程语言、系统设计

- [中文标题](链接) — 1-2 句点评。

### 开发工具

- [中文标题](链接) — 1-2 句点评。

### 安全、隐私、漏洞、加密

- [中文标题](链接) — 1-2 句点评。

### 开源趋势

- [中文标题](链接) — 1-2 句点评。

## 产品速递

- [产品名](链接) — 标语。点评。

## 新闻资讯

- [新闻标题](链接) — 1-2 句摘要。

## 播客更新

- [播客名 — 最新一期标题](链接) — 简短描述。

## 其他

- [标题](链接) — 1-2 句点评。
```

### 格式规则

- **标题层级**：一级模块用 `#`，二级模块用 `##`，三级用 `###`，条目使用列表。适配飞书 / Word 导出。
- **链接**：每个产品、仓库、新闻标题本身必须是可点击链接。绝不将 URL 放在脚注或"来源"块中。
- **简洁性**：每条点评最多 1–2 句话。
- **无凑数内容**：若某章节无值得关注内容，使用"今天暂无重大更新"等一句话说明，而非填充。
- **中文标点**：所有中文叙述使用全角标点（，。：！？、）。
- **不使用引用或代码标签**：要闻为简报而非研究报告，来源通过标题超链接体现。

---

## 输出与交付

每日要闻生成后：

1. 将完整 Markdown 内容保存为文件 `daily-briefing-{YYYY-MM-DD}.md`
2. 将文件上传供用户下载
3. 向用户展示 **"今日必读"** 部分作为预览
4. 如果用户要求上传飞书，使用 upload_to_feishu_tool 工具上传

---

## 数据源

### RSS 源

280+ 个 RSS 源，涵盖：

- **HN Popularity Contest Top 100**：Hacker News 最受欢迎个人博客
- **AI 资讯聚合**：CloudFlare AI Insight Daily、smol.ai News
- **GitHub Trending**：每日热门开源项目
- **中文技术博客**：量子位、爱范儿、阮一峰、美团技术等
- **中文 Twitter 博主**：15 位活跃技术博主
- **AI 公司官方**：OpenAI、Anthropic、Google、Meta、NVIDIA、Cursor 等
- **华人 AI 研究者**：李飞飞、吴恩达、Jerry Liu 等
- **微信公众号**：机器之心、新智元、36氪等 53 个公众号
- **财经资讯**：CNBC、MarketWatch、纳斯达克、S&P Global、Seeking Alpha 等
- **科技媒体**：Ars Technica、Wired、TechCrunch、The Verge、少数派、虎嗅、36氪等
- **时事新闻**：BBC、路透社、中国新闻网等

### web_fetch 数据源

- Product Hunt 每日排行榜
- GitHub Trending 每日热门仓库
- Google News 中文版
- 小宇宙播客平台（硅谷101、晚点聊等）

### web_search 数据源

- 阿里巴巴 / 字节跳动企业动态
- AI coding / AI healthcare 最新新闻

完整 RSS 源列表见 `scripts/rss-digest.ts` 中的 `RSS_FEEDS` 数组。

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
- Step 2–4 依赖 `web_fetch` 和 `web_search` 工具，如工具不可用则跳过对应步骤，渲染脚本会自动处理缺失数据
