---
name: rss-digest
description: |
  Daily Briefing Generator — Fetches data from RSS feeds, Product Hunt, GitHub Trending, Google News, podcasts and other sources, then applies AI scoring, categorization, summarization and translation to produce a structured daily briefing report in Chinese.

  Trigger this Skill when the user mentions any of the following scenarios:
  - Generate a daily briefing, tech digest, RSS digest, or daily news roundup
  - Fetch RSS feeds and generate summaries/reports
  - Get the latest updates from tech / product / news circles
  - Auto-categorize, score, and summarize tech articles
  - "What's new today?"
  - "Generate a daily briefing"
  - "Anything worth paying attention to today?"
  - "Tech news roundup"
  - "What's new on Product Hunt?"
  - "What's trending on GitHub today?"
  Even if the user doesn't explicitly mention RSS, this Skill should trigger whenever the request involves batch news gathering, summary report generation, or trend analysis.
---

# Daily Briefing Generator

## Architecture Overview

This Skill uses a **Script + Agent collaboration** layered architecture:

- **Script layer** (`scripts/rss-digest.ts`): RSS fetching, XML parsing, time filtering, deduplication, rule-based pre-scoring — outputs candidate articles as JSON
- **Agent layer** (the workflow described in this document): supplementary fetching via web_search / web_fetch, AI scoring, categorization, Chinese summaries, trend analysis
- **Rendering layer** (`scripts/render-digest.py`): Pure template engine that reads JSON data → outputs Markdown daily briefing

Scripts make no AI API calls. Rendering makes no AI calls. All intelligent processing is done by the Agent itself.

---

## Execution Pipeline

Upon receiving a user request, execute the following steps in order:

### Step 1: RSS Fetching + Pre-filtering

Run the script to fetch raw articles and filter candidates via rule-based pre-scoring:

```bash
SKILL_PATH="<skill-path>"
# Prefer bun > npx tsx > node (pre-compiled JS)
if command -v bun &>/dev/null; then
  RUNNER="bun run"
  SCRIPT="$SKILL_PATH/scripts/rss-digest.ts"
elif command -v tsx &>/dev/null; then
  RUNNER="tsx"
  SCRIPT="$SKILL_PATH/scripts/rss-digest.ts"
else
  RUNNER="node"
  SCRIPT="$SKILL_PATH/scripts/rss-digest.js"
fi
$RUNNER "$SCRIPT" --hours <N> --top 150 --output articles.json
```

Parameters:

| Parameter           | Description                                             | Default |
| ------------------- | ------------------------------------------------------- | ------- |
| `--hours`           | Time window (hours)                                     | 24      |
| `--top`             | Number of candidate articles retained after pre-scoring | 150     |
| `--output`          | Output JSON file path                                   | stdout  |
| `--concurrency`     | Concurrent fetch count                                  | 10      |
| `--timeout`         | Per-source timeout (ms)                                 | 15000   |
| `--min-desc-length` | Minimum description length, filters link-only posts     | 60      |

Script output JSON structure:

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
      "pubDateRelative": "2 hours ago",
      "description": "Plain text excerpt...",
      "source": "simonwillison.net",
      "sourceCategory": "tech_blog",
      "preScore": 12
    }
  ]
}
```

Articles are sorted by preScore in descending order. Progress logs go to stderr; JSON goes to stdout or file.

---

### Step 2: Fetch Product Hunt Data (AI-related, Top 3–5)

Goal: Get the **Top 3–5 AI-related products** from today's Product Hunt leaderboard.

1. Use `web_fetch` to access `https://www.producthunt.com/feed`.
2. Select **Top 3–5 AI-related products** from the leaderboard (AI tools, LLM wrappers, ML infrastructure, AI Agents, AIGC, etc.). If fewer than 3 AI-related products are available, supplement with top-ranked non-AI products and label them as non-AI.
3. For each product, collect:
   - Product name
   - One-line tagline
   - Upvote count (if available)
   - Product page link: `https://www.producthunt.com/posts/{slug}`
4. Write a brief commentary explaining why the product is worth noting.

Write results to `producthunt.json`:

```json
[
  {
    "name": "Product name",
    "tagline": "One-line tagline",
    "upvotes": 123,
    "link": "https://www.producthunt.com/posts/xxx",
    "isAI": true,
    "note": "Brief commentary"
  }
]
```

---

### Step 3: Fetch GitHub Trending Data (Top 5)

Goal: Get the **Top 5** daily trending repositories from GitHub Trending.

1. Use `web_fetch` to access `https://github.com/trending?since=daily`.
2. Extract **Top 5** repository details:
   - Full name (`owner/repo`)
   - Description
   - Primary language
   - Total star count
   - Stars gained today
3. Link: `https://github.com/{owner}/{repo}`
4. If relevant to user interests (AI Agents, TypeScript, Python, LangChain, health tech, etc.), add a brief relevance note.

Write results to `github-trending.json`:

```json
[
  {
    "name": "owner/repo",
    "description": "Repository description",
    "language": "Python",
    "stars": 12345,
    "starsToday": 234,
    "link": "https://github.com/owner/repo",
    "note": "Relevance note (optional)"
  }
]
```

---

### Step 4: Fetch News & Podcasts

This is the most editorial step — collect news from multiple sources, then curate strictly.

#### 4a: Google News — Major Breaking News

1. Use `web_fetch` to access `https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans`.
2. Scan for **major domestic and international events** — geopolitical shifts, major policy changes, natural disasters, significant economic events, landmark tech regulation, etc.
3. Only include truly significant news; skip routine political coverage and soft news.

#### 4b: Alibaba & ByteDance Corporate Updates

1. Use `web_search` to search for `Alibaba news today {YYYY-MM-DD}` or similar time-sensitive queries.
2. Use `web_search` to search for `ByteDance news today {YYYY-MM-DD}` or similar time-sensitive queries.
3. Focus on: earnings reports, major product launches, executive changes, regulatory actions, acquisitions, layoffs, stock-moving events.
4. If there is no substantive news, skip this subsection entirely — do not pad with filler.

#### 4c: AI & Health News

1. Use `web_search` to search for `AI coding news today` and `AI healthcare latest`.
2. Focus on: FDA-approved AI medical devices, major research breakthroughs (e.g., clinical data foundation models), significant funding in digital health AI, regulatory developments.

#### 4d: Curation Rules (Must Follow)

Before finalizing the news list, strictly apply these filters:

- **Timeliness**: Events must have occurred today or be imminent. Do not include yesterday's or older news, unless it broke overnight and is still developing.
- **Significance**: Would the user want to be interrupted to learn about this? If not, skip it.
- **Deduplication**: Cross-check against the user's recent briefing output (use `conversation_search` to search for the keyword "briefing" to find recent reports). Do not include news already covered in recent briefings. If uncertain, include it but mark as developing.
- **Result**: Across all subcategories, aim for **3–8 news items** total. Less is better than padding.

#### 4e: Fetch Podcast Updates

1. Use `web_fetch` to visit the following podcast pages and check for updates:
   - [Silicon Valley 101](https://www.xiaoyuzhoufm.com/podcast/5e5c52c9418a84a04625e6cc)
   - [Luo Yonghao's Crossroads](https://www.xiaoyuzhoufm.com/podcast/68981df29e7bcd326eb91d88)
   - [Crossing](https://www.xiaoyuzhoufm.com/podcast/60502e253c92d4f62c2a9577)
   - [LatePost Chat](https://www.xiaoyuzhoufm.com/podcast/61933ace1b4320461e91fd55)
   - [elsewhere](https://www.xiaoyuzhoufm.com/podcast/68ff657d9c745a6e69da8fcf)

2. Only include podcasts updated within the last 48 hours.

Write news and podcast results to `news.json`:

```json
{
  "news": [
    {
      "title": "News headline",
      "link": "https://...",
      "source": "Source name",
      "category": "breaking / corporate / ai_health",
      "summary": "One-sentence summary"
    }
  ],
  "podcasts": [
    {
      "name": "Podcast name",
      "episode": "Latest episode title",
      "link": "https://...",
      "summary": "Brief description"
    }
  ]
}
```

---

### Step 5: AI Scoring + Categorization + Summarization (Two-phase Merge)

Read articles.json, combine with data from Steps 2–4, and execute two-phase processing.

**Language rule: ALL generated text must be in Chinese.** This includes chineseTitle, summary, recommendation, keywords, trend highlights, and every piece of user-facing text. English source material must be translated. There should be zero English sentences in the final output (proper nouns, brand names, and technical terms like "LLM", "GPT-4" are acceptable in English).

#### Phase A — Full Scoring

Score and categorize all candidate articles (typically ≤80). Process in batches of **20 articles**.

Score each article on three dimensions (1–10):

| Dimension  | Description                                                                              |
| ---------- | ---------------------------------------------------------------------------------------- |
| relevance  | Relevance to tech practitioners and news-aware professionals                             |
| quality    | Content depth, insight, technical substance (low scores for link-only/reposts/fragments) |
| timeliness | Newsworthiness and recency of the topic                                                  |

Also assign each article to one of these categories. **Read the article's actual content, not just keywords in the title.** A title mentioning "算力" or "AI" does not automatically make it AI/ML — the article might be about policy, business, or infrastructure.

| Category    | Belongs here                                                                   | Does NOT belong here (common mistakes)                                    |
| ----------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| AI / ML     | Technical AI research, model training, LLM capabilities, ML frameworks         | Government AI policy → News; AI company funding → News; smart city → News |
| Engineering | Software architecture, programming techniques, system design, coding practices | Hardware manufacturing → Product/News; 3D printing → Product/News         |
| Tools       | Developer tools, newly released libraries/frameworks, IDE plugins              | Non-developer products → Product                                          |
| Security    | Vulnerabilities, CVEs, privacy techniques, cryptography                        | Data privacy regulations → News                                           |
| Open Source | Open source projects, community trends, license changes                        | A company open-sourcing a product → Product                               |
| Product     | Product launches, hardware, consumer tech, reviews, UX                         | —                                                                         |
| News        | Government policy, funding/financing, corporate moves, regulations, geopolitics, industry trends | —                                                  |
| Other       | Content that doesn't fit the above categories                                  | —                                                                         |

**Classification decision tree** (apply in order):
1. Is this about government policy, regulation, corporate financing, or geopolitical events? → **News**
2. Is this about a tangible product launch, hardware, or consumer tech? → **Product**
3. Is this a technical deep-dive into AI/ML algorithms, models, or training? → **AI / ML**
4. Is this about software engineering practices, architecture, or coding? → **Engineering**
5. Is this a developer tool or framework release? → **Tools**
6. Is this about security vulnerabilities or cryptography? → **Security**
7. Is this about open source communities or projects? → **Open Source**
8. None of the above → **Other**

Extract **2–4 Chinese keywords** for each article.

Generate **`chineseTitle`** (Chinese title) for every article — not just the Top N. For originally Chinese articles, use the original title directly. For English articles, translate naturally (not word-for-word). This ensures the final briefing is fully Chinese regardless of which articles pass the score threshold.

#### Phase B — Top N Summarization

After Phase A, sort by `totalScore = relevance + quality + timeliness` in descending order, take the **Top N** (default 15, user-configurable) and generate additional fields:

- **summary**: Chinese structured summary (4–6 sentences) covering: core issue → key arguments/findings → conclusion/impact. **Must be in Chinese even if the source is English.**
- **recommendation**: 1–2 sentence Chinese recommendation explaining why it's worth reading. **Must be in Chinese.**

#### Output Format (Strict Constraints)

Merge Phase A + B results into **one** JSON file `scored.json`.

Format as a **flat array** — no nested wrappers. Each element structure:

```json
[
  {
    "title": "Original title",
    "link": "https://...",
    "source": "simonwillison.net",
    "pubDate": "2026-01-01T10:00:00Z",
    "pubDateRelative": "2 hours ago",
    "description": "Original description",
    "relevance": 8,
    "quality": 7,
    "timeliness": 9,
    "totalScore": 24,
    "category": "AI / ML",
    "keywords": ["AI Agent", "调试框架"],
    "chineseTitle": "微软发布 AgentRx：AI Agent 系统性调试框架",
    "summary": "微软研究院发布了 AgentRx 框架……（仅 Top N 有此字段）",
    "recommendation": "对于构建 AI Agent 的团队……（仅 Top N 有此字段）"
  }
]
```

**Format Hard Constraints (Violations Are Bugs)**:

1. Top level must be a JSON array `[...]` — `{"articles": [...]}`, `{"batch": ...}` and other wrappers are forbidden
2. Scoring fields `relevance`, `quality`, `timeliness`, `totalScore` must be flat — nesting into a `scores` or `score` object is forbidden
3. `totalScore` must equal `relevance + quality + timeliness`
4. **Every article must have a `chineseTitle` field** (Chinese title). Articles outside the Top N must not have `summary` or `recommendation` fields.
5. `keywords` is an array of Chinese keywords
6. All articles sorted by `totalScore` in descending order

**Processing Flow**:

1. Read the articles array from articles.json
2. Score in batches (20 articles per batch), generating scores + category + keywords + `chineseTitle` for every article
3. After all scoring is complete, sort and generate `summary` + `recommendation` for Top N only in a single pass
4. Write the complete array to `scored.json` in one operation

---

### Step 6: Trend Summary

Based on the Top N articles in scored.json, combined with data from Steps 2–4, summarize in **Chinese**:

```json
{
  "highlights": "A paragraph of 3-5 sentences summarizing macro trends",
  "trends": [
    {
      "title": "Trend title",
      "description": "Brief trend description"
    }
  ]
}
```

- `highlights`: A concise paragraph (2–3 sentences) summarizing today's macro picture. This is rendered as a blockquote lead-in, so keep it punchy and informative.
- `trends`: 2–4 specific trends, each with a short title and a 1-sentence description. These are rendered as a bold-title bullet list below the highlights.

Write results to `trends.json`.

---

### Step 7: Rendering

Use the Python script to assemble data into a Markdown daily briefing:

```bash
python3 "$SKILL_PATH/scripts/render-digest.py" \
  --articles articles.json \
  --scored scored.json \
  --trends trends.json \
  --producthunt producthunt.json \
  --github github-trending.json \
  --news news.json \
  --output "daily-briefing-$(date +%Y-%m-%d).md" \
  --min-score 12
```

| Parameter       | Description                             | Default  |
| --------------- | --------------------------------------- | -------- |
| `--articles`    | Raw fetch data from Step 1              | Required |
| `--scored`      | Scoring results from Step 5             | Required |
| `--trends`      | Trend summary from Step 6               | Required |
| `--producthunt` | Product Hunt data from Step 2           | Required |
| `--github`      | GitHub Trending data from Step 3        | Required |
| `--news`        | News and podcast data from Step 4       | Required |
| `--output`      | Output Markdown file path               | Required |
| `--min-score`   | Minimum score for category list display | 12       |
| `--top-n`       | Number of must-read articles            | 5        |

The script automatically generates these sections:

| Section         | Content                                                                          |
| --------------- | -------------------------------------------------------------------------------- |
| Must Read       | Top N in-depth showcase (Chinese title hyperlink + 1–2 sentence commentary)      |
| Tech            | Grouped by subcategory: AI/ML, Engineering, Tools, Security, Open Source         |
| Product Express | Product Hunt AI products + GitHub Trending repos + RSS Product-category articles |
| News            | Breaking news, corporate updates, AI health news + RSS News-category articles    |
| Podcast Updates | Recently updated podcasts (if any)                                               |
| Other           | Valuable content that doesn't fit above categories (omitted if none)             |

---

## Output Format Specification

### Markdown Template

```markdown
# 每日要闻 | {YYYY-MM-DD}

> （趋势导语：2–3 句话概括今日全局）

**今日趋势**

- **趋势标题** — 一句话描述
- **趋势标题** — 一句话描述

## 今日必读

- [Chinese title](link) — 1–2 sentence commentary.

## Tech

### AI, Machine Learning, LLM, Deep Learning

- [Chinese title](link) — 1–2 sentence commentary.

### Software Engineering, Architecture, Programming Languages, System Design

- [Chinese title](link) — 1–2 sentence commentary.

### Developer Tools

- [Chinese title](link) — 1–2 sentence commentary.

### Security, Privacy, Vulnerabilities, Cryptography

- [Chinese title](link) — 1–2 sentence commentary.

### Open Source Trends

- [Chinese title](link) — 1–2 sentence commentary.

## Product Express

- [Product name](link) — Tagline. Commentary.

## News

- [News headline](link) — 1–2 sentence summary.

## Podcast Updates

- [Podcast name — Latest episode title](link) — Brief description.

## Other

- [Title](link) — 1–2 sentence commentary.
```

### Formatting Rules

- **Heading levels**: Top-level modules use `#`, second-level use `##`, third-level use `###`, items use lists. Compatible with Feishu / Word export.
- **Links**: Every product, repository, and news headline must be a clickable link. Never put URLs in footnotes or "source" blocks.
- **Conciseness**: Each commentary is at most 1–2 sentences.
- **No filler content**: If a section has nothing noteworthy, use a single sentence like "No major updates today" rather than padding.
- **Chinese punctuation**: All Chinese prose uses full-width punctuation (，。：！？、).
- **No code blocks in the briefing body**: The briefing is a digest, not a research report — sources are conveyed through title hyperlinks.
- **No raw HTML**: If any description or summary contains HTML tags or CSS fragments, it's a bug. All content must be pure plain text or Markdown.

---

## Output & Delivery

After the daily briefing is generated:

1. Save the complete Markdown content as `daily-briefing-{YYYY-MM-DD}.md`
2. Upload the file for user download
3. Show the user the **"Must Read"** section as a preview
4. If the user requests Feishu upload, use the upload_to_feishu_tool to upload

---

## Data Sources

### RSS Feeds

280+ RSS feeds covering:

- **HN Popularity Contest Top 100**: Hacker News most popular personal blogs
- **AI News Aggregators**: CloudFlare AI Insight Daily, smol.ai News
- **GitHub Trending**: Daily trending open source projects
- **Chinese Tech Blogs**: Quantumbit, ifanr, Ruan Yifeng, Meituan Tech, etc.
- **Chinese Twitter Bloggers**: 15 active tech bloggers
- **AI Company Official**: OpenAI, Anthropic, Google, Meta, NVIDIA, Cursor, etc.
- **Chinese AI Researchers**: Fei-Fei Li, Andrew Ng, Jerry Liu, etc.
- **WeChat Official Accounts**: Jiqizhixin, Xinzhiyuan, 36Kr, etc. (53 accounts)
- **Finance News**: CNBC, MarketWatch, Nasdaq, S&P Global, Seeking Alpha, etc.
- **Tech Media**: Ars Technica, Wired, TechCrunch, The Verge, SSPAI, Huxiu, 36Kr, etc.
- **Current Affairs**: BBC, Reuters, China News Service, etc.

### web_fetch Sources

- Product Hunt daily leaderboard
- GitHub Trending daily popular repositories
- Google News Chinese edition
- Xiaoyuzhou podcast platform (Silicon Valley 101, LatePost Chat, etc.)

### web_search Sources

- Alibaba / ByteDance corporate updates
- AI coding / AI healthcare latest news

The complete RSS feed list is in the `RSS_FEEDS` array in `scripts/rss-digest.ts`.

---

## User-configurable Parameters

| Parameter             | Description                                             | Default                  |
| --------------------- | ------------------------------------------------------- | ------------------------ |
| Time window           | Only look at articles from the last N hours             | 48 hours                 |
| Top N                 | Number of articles to generate detailed summaries for   | 15                       |
| Candidate pool        | Number of candidate articles retained after pre-scoring | 150                      |
| Minimum display score | Minimum score for category list display                 | 12                       |
| Output format         | Markdown / Feishu document                              | Markdown                 |
| Focus areas           | Scoring weight bias toward certain categories           | No preference (balanced) |

---

## Notes

- Script is compatible with Bun, tsx, and plain Node.js 18+ (via pre-compiled `rss-digest.js`); Bun is preferred
- Script progress logs go to stderr and do not pollute JSON data output
- When fewer than 5 articles are found, the script automatically expands the time window
- `--min-desc-length` filters link-only tweets, improving signal-to-noise ratio
- The rendering script is pure Python (zero dependencies) and requires no AI calls
- **All user-facing text output is in Chinese** (summaries, title translations, recommendations, trend summaries, keywords)
- Steps 2–4 depend on `web_fetch` and `web_search` tools; if these tools are unavailable, skip the corresponding steps — the rendering script automatically handles missing data
