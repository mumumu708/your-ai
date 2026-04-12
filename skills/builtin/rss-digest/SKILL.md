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
allowed-tools: Agent Task
---

# Daily Briefing Generator

## Architecture

**Script + Agent + Rendering** layered architecture with parallel sub-agent execution:

- **Script layer** (`scripts/rss-digest.ts`): RSS fetching, XML parsing, pre-scoring — deterministic, no AI calls
- **Agent layer** (this document): orchestrates parallel sub-agents for data collection and analysis
- **Rendering layer** (`scripts/render-digest.py`): JSON → Markdown — deterministic, no AI calls

Reference files (read on demand, not upfront):
- `references/scoring-rules.md` — scoring dimensions, categories, decision tree
- `references/output-schema.md` — JSON schemas, Markdown template, formatting rules
- `references/data-sources.md` — full source list, curation rules, podcast URLs

---

## Execution Pipeline

```
Phase 0 (serial)  → Prepare workspace, resolve parameters
Phase 1 (parallel) → Spawn 4 sub-agents: RSS / ProductHunt / GitHub / News+Podcasts
Phase 2 (serial)  → Fan-in: merge and deduplicate all collected data
Phase 3 (parallel) → Spawn 2 sub-agents: Scoring+Categorization / Trend Analysis
Phase 4 (serial)  → Render final Markdown report
```

### Phase 0: Setup

1. Resolve user parameters (time window, Top N, etc.) — see "User Parameters" below.
2. Create a workspace directory for intermediate JSON files.
3. Determine script runner: prefer `bun` > `tsx` > `node` (pre-compiled JS).

### Phase 1: Parallel Data Collection (fan-out)

**Spawn 4 sub-agents concurrently.** Each sub-agent writes its output to a known path in the workspace. Provide each sub-agent with the workspace path and clear task boundaries.

#### Sub-agent A: RSS Fetching

```bash
SKILL_PATH="<skill-path>"
# Select runner
if command -v bun &>/dev/null; then
  bun run "$SKILL_PATH/scripts/rss-digest.ts" --hours <N> --top 150 --output "$WORKSPACE/articles.json"
elif command -v tsx &>/dev/null; then
  tsx "$SKILL_PATH/scripts/rss-digest.ts" --hours <N> --top 150 --output "$WORKSPACE/articles.json"
else
  node "$SKILL_PATH/scripts/rss-digest.js" --hours <N> --top 150 --output "$WORKSPACE/articles.json"
fi
```

| Parameter           | Description                                   | Default |
| ------------------- | --------------------------------------------- | ------- |
| `--hours`           | Time window (hours)                           | 24      |
| `--top`             | Candidates retained after pre-scoring         | 150     |
| `--concurrency`     | Concurrent fetch count                        | 10      |
| `--timeout`         | Per-source timeout (ms)                       | 15000   |
| `--min-desc-length` | Minimum description length                    | 60      |

Output: `articles.json` — see `references/output-schema.md` for structure.

#### Sub-agent B: Product Hunt

Use `web_fetch` to access `https://www.producthunt.com/feed`. Select **Top 3–5 AI-related products**. For each, collect: name, tagline, upvotes, link, AI flag, brief commentary. Read `references/data-sources.md` for detailed instructions.

Output: `producthunt.json`

#### Sub-agent C: GitHub Trending

Use `web_fetch` to access `https://github.com/trending?since=daily`. Extract **Top 5** repos with: full name, description, language, stars, starsToday, link, relevance note.

Output: `github-trending.json`

#### Sub-agent D: News & Podcasts

Collect from 4 sub-sources (Google News, corporate updates, AI/health news, podcasts). Read `references/data-sources.md` for URLs, search queries, and curation rules. Across all sub-sources, aim for **3–8 news items** total — less is better than padding.

Output: `news.json`

### Phase 2: Fan-in & Merge

After all 4 sub-agents complete:
1. Verify all output files exist: `articles.json`, `producthunt.json`, `github-trending.json`, `news.json`
2. If any sub-agent failed, log a warning and proceed with available data — the rendering script handles missing files gracefully
3. Cross-deduplicate articles against news items (by URL)

### Phase 3: Parallel Analysis (fan-out)

**Spawn 2 sub-agents concurrently.**

#### Sub-agent E: AI Scoring + Categorization

Read `references/scoring-rules.md` for the complete scoring protocol. Process all articles from `articles.json` in two phases:
- **Phase A**: Score every article (relevance/quality/timeliness), assign category, generate chineseTitle and keywords — batch 20 at a time
- **Phase B**: For Top N articles by totalScore, generate Chinese summary + recommendation

Read `references/output-schema.md` for the strict JSON format constraints.

Output: `scored.json`

#### Sub-agent F: Trend Analysis

Based on the Top N articles in `articles.json` (by preScore) combined with data from `producthunt.json`, `github-trending.json`, and `news.json`, summarize macro trends in **Chinese**:
- `highlights`: 2–3 sentence macro picture
- `trends`: 2–4 specific trends with title + description

Output: `trends.json`

### Phase 4: Render

Run the rendering script to assemble all JSON data into the final Markdown briefing:

```bash
python3 "$SKILL_PATH/scripts/render-digest.py" \
  --articles "$WORKSPACE/articles.json" \
  --scored "$WORKSPACE/scored.json" \
  --trends "$WORKSPACE/trends.json" \
  --producthunt "$WORKSPACE/producthunt.json" \
  --github "$WORKSPACE/github-trending.json" \
  --news "$WORKSPACE/news.json" \
  --output "$WORKSPACE/daily-briefing-$(date +%Y-%m-%d).md" \
  --min-score 12
```

Read `references/output-schema.md` for the Markdown template and formatting rules.

### Delivery

1. Save as `daily-briefing-{YYYY-MM-DD}.md`
2. Upload the file for user download
3. Show the "今日必读" section as a preview
4. If the user requests Feishu upload, use the upload tool

---

## User Parameters

| Parameter             | Description                                             | Default                  |
| --------------------- | ------------------------------------------------------- | ------------------------ |
| Time window           | Only look at articles from the last N hours             | 48 hours                 |
| Top N                 | Number of articles to generate detailed summaries for   | 15                       |
| Candidate pool        | Candidates retained after pre-scoring                   | 150                      |
| Minimum display score | Minimum score for category list display                 | 12                       |
| Output format         | Markdown / Feishu document                              | Markdown                 |
| Focus areas           | Scoring weight bias toward certain categories           | No preference (balanced) |

## Notes

- Script is compatible with Bun, tsx, and Node.js 18+ (via pre-compiled `rss-digest.js`); Bun is preferred
- When fewer than 5 articles are found, the script automatically expands the time window
- The rendering script is pure Python (zero dependencies) and requires no AI calls
- **All user-facing text output is in Chinese**
- Steps 2–4 depend on `web_fetch` and `web_search` tools; if unavailable, skip — the rendering script handles missing data gracefully
