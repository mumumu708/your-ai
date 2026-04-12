# Data Sources

## RSS Feeds (280+)

The complete feed list is defined in the `RSS_FEEDS` array in `scripts/rss-digest.ts`.

| Category                        | Count | Examples                                                  |
| ------------------------------- | ----- | --------------------------------------------------------- |
| HN Popularity Contest Top 100   | ~100  | Hacker News most popular personal blogs                   |
| AI News Aggregators             | 2     | CloudFlare AI Insight Daily, smol.ai News                 |
| GitHub Trending                 | 1     | Daily trending open source projects                       |
| Chinese Tech Blogs              | 6     | Quantumbit, ifanr, Ruan Yifeng, Meituan Tech, etc.       |
| Chinese Twitter Bloggers        | 15    | Active tech bloggers via RSS bridge                       |
| Chinese AI Companies            | 11    | Zhipu, Moonshot, Baichuan, etc.                           |
| International AI Researchers    | 8     | Fei-Fei Li, Andrew Ng, Jerry Liu, etc.                    |
| AI Company Official             | 17    | OpenAI, Anthropic, Google, Meta, NVIDIA, Cursor, etc.     |
| Developer Tools                 | 12    | Various developer tool blogs                              |
| AI Research & News              | 16    | ML research feeds                                         |
| WeChat Official Accounts        | 53    | Jiqizhixin, Xinzhiyuan, 36Kr, etc.                        |
| Finance News                    | 13    | CNBC, MarketWatch, Nasdaq, S&P Global, Seeking Alpha      |
| Tech Media                      | 7     | Ars Technica, Wired, TechCrunch, The Verge, SSPAI, Huxiu  |
| Current Affairs                 | 5     | BBC, Reuters, China News Service, etc.                    |

## Product Hunt

- URL: `https://www.producthunt.com/feed`
- Tool: `web_fetch`
- Target: Top 3–5 AI-related products from the daily leaderboard
- Collect: name, tagline, upvotes, link, AI relevance note

## GitHub Trending

- URL: `https://github.com/trending?since=daily`
- Tool: `web_fetch`
- Target: Top 5 daily trending repositories
- Collect: full name, description, language, stars, starsToday, link, relevance note

## News Sources

### Google News — Major Breaking News
- URL: `https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans`
- Tool: `web_fetch`
- Focus: major domestic/international events — geopolitical shifts, major policy changes, natural disasters, significant economic events, landmark tech regulation
- Only truly significant news; skip routine political coverage and soft news

### Alibaba & ByteDance Corporate Updates
- Tool: `web_search` with queries like `Alibaba news today {YYYY-MM-DD}`, `ByteDance news today {YYYY-MM-DD}`
- Focus: earnings reports, major product launches, executive changes, regulatory actions, acquisitions, layoffs, stock-moving events
- If no substantive news, skip entirely — do not pad with filler

### AI & Health News
- Tool: `web_search` with queries like `AI coding news today`, `AI healthcare latest`
- Focus: FDA-approved AI medical devices, major research breakthroughs, significant funding in digital health AI, regulatory developments

### News Curation Rules (Must Follow)

- **Timeliness**: Events must have occurred today or be imminent. Do not include yesterday's or older news, unless it broke overnight and is still developing.
- **Significance**: Would the user want to be interrupted to learn about this? If not, skip it.
- **Deduplication**: Cross-check against recent briefing output. Do not include news already covered in recent briefings.
- **Result**: Across all subcategories, aim for **3–8 news items** total. Less is better than padding.

## Podcasts

Check for updates within the last 48 hours via `web_fetch`:

| Podcast                    | URL                                                                    |
| -------------------------- | ---------------------------------------------------------------------- |
| Silicon Valley 101         | https://www.xiaoyuzhoufm.com/podcast/5e5c52c9418a84a04625e6cc          |
| Luo Yonghao's Crossroads   | https://www.xiaoyuzhoufm.com/podcast/68981df29e7bcd326eb91d88          |
| Crossing                   | https://www.xiaoyuzhoufm.com/podcast/60502e253c92d4f62c2a9577          |
| LatePost Chat              | https://www.xiaoyuzhoufm.com/podcast/61933ace1b4320461e91fd55          |
| elsewhere                  | https://www.xiaoyuzhoufm.com/podcast/68ff657d9c745a6e69da8fcf          |
