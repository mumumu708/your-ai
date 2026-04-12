# Output Schema & Formatting

## Intermediate JSON Schemas

### scored.json (Phase A + B merged)

Format as a **flat array** — no nested wrappers.

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

**Hard Constraints (Violations Are Bugs)**:

1. Top level must be a JSON array `[...]` — `{"articles": [...]}`, `{"batch": ...}` and other wrappers are forbidden
2. Scoring fields `relevance`, `quality`, `timeliness`, `totalScore` must be flat — nesting into a `scores` or `score` object is forbidden
3. `totalScore` must equal `relevance + quality + timeliness`
4. **Every article must have a `chineseTitle` field**. Articles outside the Top N must not have `summary` or `recommendation` fields.
5. `keywords` is an array of Chinese keywords
6. All articles sorted by `totalScore` in descending order

### producthunt.json

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

### github-trending.json

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

### news.json

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

### trends.json

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

- `highlights`: 2–3 sentences summarizing today's macro picture. Rendered as a blockquote lead-in — keep it punchy.
- `trends`: 2–4 specific trends, each with a short title and a 1-sentence description.

## Markdown Output Template

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

## Formatting Rules

- **Heading levels**: Top-level modules use `#`, second-level use `##`, third-level use `###`, items use lists. Compatible with Feishu / Word export.
- **Links**: Every product, repository, and news headline must be a clickable link. Never put URLs in footnotes or "source" blocks.
- **Conciseness**: Each commentary is at most 1–2 sentences.
- **No filler content**: If a section has nothing noteworthy, use a single sentence like "No major updates today" rather than padding.
- **Chinese punctuation**: All Chinese prose uses full-width punctuation (，。：！？、).
- **No code blocks in the briefing body**: The briefing is a digest, not a research report — sources are conveyed through title hyperlinks.
- **No raw HTML**: If any description or summary contains HTML tags or CSS fragments, it's a bug. All content must be pure plain text or Markdown.
