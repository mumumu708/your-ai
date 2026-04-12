# Scoring Rules & Categorization

## Phase A — Full Scoring

Score and categorize all candidate articles (typically ≤80). Process in batches of **20 articles**.

**Language rule: ALL generated text must be in Chinese.** This includes chineseTitle, summary, recommendation, keywords, trend highlights, and every piece of user-facing text. English source material must be translated. There should be zero English sentences in the final output (proper nouns, brand names, and technical terms like "LLM", "GPT-4" are acceptable in English).

### Scoring Dimensions (1–10 each)

| Dimension  | Description                                                                              |
| ---------- | ---------------------------------------------------------------------------------------- |
| relevance  | Relevance to tech practitioners and news-aware professionals                             |
| quality    | Content depth, insight, technical substance (low scores for link-only/reposts/fragments) |
| timeliness | Newsworthiness and recency of the topic                                                  |

`totalScore = relevance + quality + timeliness`

### Category Definitions

Assign each article to one of these categories. **Read the article's actual content, not just keywords in the title.** A title mentioning "算力" or "AI" does not automatically make it AI/ML — the article might be about policy, business, or infrastructure.

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

### Classification Decision Tree (apply in order)

1. Is this about government policy, regulation, corporate financing, or geopolitical events? → **News**
2. Is this about a tangible product launch, hardware, or consumer tech? → **Product**
3. Is this a technical deep-dive into AI/ML algorithms, models, or training? → **AI / ML**
4. Is this about software engineering practices, architecture, or coding? → **Engineering**
5. Is this a developer tool or framework release? → **Tools**
6. Is this about security vulnerabilities or cryptography? → **Security**
7. Is this about open source communities or projects? → **Open Source**
8. None of the above → **Other**

### Per-Article Output

For every article, generate:
- `chineseTitle`: Chinese title. For originally Chinese articles, use the original title. For English articles, translate naturally (not word-for-word).
- `keywords`: Array of 2–4 Chinese keywords
- `category`: One of the 8 categories above
- `relevance`, `quality`, `timeliness`: Integer scores 1–10
- `totalScore`: Sum of the three scores

## Phase B — Top N Summarization

After Phase A, sort by `totalScore` descending, take **Top N** (default 15, user-configurable) and generate:

- **summary**: Chinese structured summary (4–6 sentences) covering: core issue → key arguments/findings → conclusion/impact. **Must be in Chinese even if the source is English.**
- **recommendation**: 1–2 sentence Chinese recommendation explaining why it's worth reading. **Must be in Chinese.**

### Processing Flow

1. Read the articles array from articles.json
2. Score in batches (20 articles per batch), generating scores + category + keywords + `chineseTitle` for every article
3. After all scoring is complete, sort and generate `summary` + `recommendation` for Top N only in a single pass
4. Write the complete array to `scored.json` in one operation
