#!/usr/bin/env python3
"""render-digest.py – 将 JSON 数据渲染为 Markdown 每日要闻（零依赖）。

Usage:
    python3 render-digest.py \
        --articles articles.json \
        --scored scored.json \
        --output daily-briefing-2026-03-17.md \
        --min-score 15 \
        --top-n 5

可选参数：
    --trends trends.json
    --producthunt producthunt.json
    --github github-trending.json
    --news news.json
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys

# ── 分类映射 ──────────────────────────────────────────────────────────────────

TECH_SUBCATEGORIES = {
    "AI / ML": "AI、机器学习、LLM、深度学习",
    "Engineering": "软件工程、架构、编程语言、系统设计",
    "Tools": "开发工具",
    "Security": "安全、隐私、漏洞、加密",
    "Open Source": "开源趋势",
}

TECH_ORDER = ["AI / ML", "Engineering", "Tools", "Security", "Open Source"]

# ── 工具函数 ──────────────────────────────────────────────────────────────────


def _load_json(path: str) -> object:
    """读取 JSON 文件，失败时打印友好错误并退出。"""
    if not os.path.isfile(path):
        print(f"错误: 文件不存在 – {path}", file=sys.stderr)
        sys.exit(1)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError) as exc:
        print(f"错误: 无法读取 – {path}: {exc}", file=sys.stderr)
        sys.exit(1)


def _safe(obj: dict, key: str, default=""):
    """安全读取字典字段。"""
    val = obj.get(key)
    return val if val is not None else default


def _extract_date(fetched_at: str) -> str:
    """从 fetchedAt ISO 字符串中提取日期 YYYY-MM-DD。"""
    try:
        dt = datetime.datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d")
    except Exception:
        if len(fetched_at) >= 10:
            return fetched_at[:10]
        return datetime.date.today().isoformat()


def _comment(art: dict) -> str:
    """从推荐理由或摘要中提取简短点评。"""
    rec = _safe(art, "recommendation", "")
    if rec:
        return rec
    summary = _safe(art, "summary", "")
    if summary:
        return summary[:100] + ("..." if len(summary) > 100 else "")
    desc = _safe(art, "description", "")
    if desc:
        return desc[:80] + ("..." if len(desc) > 80 else "")
    return ""


# ── 构建各段 Markdown ─────────────────────────────────────────────────────────


def _build_header(articles_meta: dict) -> str:
    date_str = _extract_date(_safe(articles_meta, "fetchedAt", ""))
    return f"# 每日要闻 | {date_str}\n"


def _build_highlights(trends: dict) -> str:
    """趋势导语。"""
    highlights = _safe(trends, "highlights", "")
    if not highlights:
        return ""
    return f"{highlights}\n"


def _build_must_read(scored: list, top_n: int) -> str:
    lines = ["## 今日必读", ""]
    top_articles = scored[:top_n]
    if not top_articles:
        lines.append("今天暂无特别推荐。")
        lines.append("")
        return "\n".join(lines)

    for art in top_articles:
        chinese_title = _safe(art, "chineseTitle", _safe(art, "title"))
        link = _safe(art, "link", "")
        c = _comment(art)
        if c:
            lines.append(f"- [{chinese_title}]({link}) — {c}")
        else:
            lines.append(f"- [{chinese_title}]({link})")

    lines.append("")
    return "\n".join(lines)


def _build_tech_section(scored: list, min_score: int, top_n: int) -> str:
    rest = scored[top_n:]
    tech_articles: dict[str, list] = {cat: [] for cat in TECH_ORDER}

    for art in rest:
        cat = _safe(art, "category", "")
        total = _safe(art, "totalScore", 0)
        if cat in tech_articles and total >= min_score:
            tech_articles[cat].append(art)

    has_tech = any(len(arts) > 0 for arts in tech_articles.values())
    if not has_tech:
        return ""

    lines = ["## 技术", ""]

    for cat in TECH_ORDER:
        arts = tech_articles[cat]
        sub_title = TECH_SUBCATEGORIES[cat]
        lines.append(f"### {sub_title}")
        lines.append("")
        if not arts:
            lines.append("今天暂无重大更新。")
            lines.append("")
            continue
        for art in arts:
            display_title = _safe(art, "chineseTitle", _safe(art, "title"))
            link = _safe(art, "link", "")
            c = _comment(art)
            if c:
                lines.append(f"- [{display_title}]({link}) — {c}")
            else:
                lines.append(f"- [{display_title}]({link})")
        lines.append("")

    return "\n".join(lines)


def _build_product_section(
    producthunt: list,
    github: list,
    scored: list,
    min_score: int,
    top_n: int,
) -> str:
    rest = scored[top_n:]
    product_arts = [
        a
        for a in rest
        if _safe(a, "category", "") == "Product"
        and _safe(a, "totalScore", 0) >= min_score
    ]

    has_ph = producthunt and len(producthunt) > 0
    has_gh = github and len(github) > 0
    has_arts = len(product_arts) > 0

    if not has_ph and not has_gh and not has_arts:
        return ""

    lines = ["## 产品速递", ""]

    if has_ph:
        for p in producthunt:
            name = _safe(p, "name", "")
            link = _safe(p, "link", "")
            tagline = _safe(p, "tagline", "")
            note = _safe(p, "note", "")
            upvotes = _safe(p, "upvotes", "")
            upvote_str = f"（{upvotes} 票）" if upvotes else ""
            comment = note if note else tagline
            lines.append(f"- [{name}]({link}){upvote_str} — {comment}")

    if has_gh:
        for r in github:
            name = _safe(r, "name", "")
            link = _safe(r, "link", "")
            desc = _safe(r, "description", "")
            lang = _safe(r, "language", "")
            stars_today = _safe(r, "starsToday", "")
            note = _safe(r, "note", "")
            parts = []
            if desc:
                parts.append(desc)
            meta = []
            if lang:
                meta.append(lang)
            if stars_today:
                meta.append(f"今日 +{stars_today} star")
            if meta:
                parts.append("（" + "，".join(meta) + "）")
            if note:
                parts.append(note)
            comment = "".join(parts)
            if comment:
                lines.append(f"- [{name}]({link}) — {comment}")
            else:
                lines.append(f"- [{name}]({link})")

    if has_arts:
        for art in product_arts:
            display_title = _safe(art, "chineseTitle", _safe(art, "title"))
            link = _safe(art, "link", "")
            c = _comment(art)
            if c:
                lines.append(f"- [{display_title}]({link}) — {c}")
            else:
                lines.append(f"- [{display_title}]({link})")

    lines.append("")
    return "\n".join(lines)


def _build_news_section(
    news_data: dict,
    scored: list,
    min_score: int,
    top_n: int,
) -> str:
    rest = scored[top_n:]
    news_arts = [
        a
        for a in rest
        if _safe(a, "category", "") == "News"
        and _safe(a, "totalScore", 0) >= min_score
    ]

    has_web_news = news_data and _safe(news_data, "news", [])
    has_rss_news = len(news_arts) > 0

    if not has_web_news and not has_rss_news:
        return "## 新闻资讯\n\n今天暂无重大新闻。\n"

    lines = ["## 新闻资讯", ""]

    if has_web_news:
        for item in news_data["news"]:
            title = _safe(item, "title", "")
            link = _safe(item, "link", "")
            summary = _safe(item, "summary", "")
            if title:
                if summary:
                    lines.append(f"- [{title}]({link}) — {summary}")
                else:
                    lines.append(f"- [{title}]({link})")

    if has_rss_news:
        for art in news_arts:
            display_title = _safe(art, "chineseTitle", _safe(art, "title"))
            link = _safe(art, "link", "")
            c = _comment(art)
            if c:
                lines.append(f"- [{display_title}]({link}) — {c}")
            else:
                lines.append(f"- [{display_title}]({link})")

    lines.append("")
    return "\n".join(lines)


def _build_podcast_section(news_data: dict) -> str:
    podcasts = _safe(news_data, "podcasts", [])
    if not podcasts:
        return ""

    lines = ["## 播客更新", ""]

    for p in podcasts:
        name = _safe(p, "name", "")
        episode = _safe(p, "episode", "")
        link = _safe(p, "link", "")
        summary = _safe(p, "summary", "")
        display = f"{name} — {episode}" if episode else name
        if summary:
            lines.append(f"- [{display}]({link}) — {summary}")
        else:
            lines.append(f"- [{display}]({link})")

    lines.append("")
    return "\n".join(lines)


def _build_other_section(scored: list, min_score: int, top_n: int) -> str:
    rest = scored[top_n:]
    others = [
        a
        for a in rest
        if _safe(a, "category", "") == "Other"
        and _safe(a, "totalScore", 0) >= min_score
    ]

    if not others:
        return ""

    lines = ["## 其他", ""]

    for art in others:
        display_title = _safe(art, "chineseTitle", _safe(art, "title"))
        link = _safe(art, "link", "")
        c = _comment(art)
        if c:
            lines.append(f"- [{display_title}]({link}) — {c}")
        else:
            lines.append(f"- [{display_title}]({link})")

    lines.append("")
    return "\n".join(lines)


# ── 主函数 ────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description="将 JSON 数据渲染为 Markdown 每日要闻"
    )
    parser.add_argument("--articles", required=True, help="articles.json 路径")
    parser.add_argument("--scored", required=True, help="scored.json 路径")
    parser.add_argument("--trends", required=True, help="trends.json 路径")
    parser.add_argument("--producthunt", required=True, help="producthunt.json 路径")
    parser.add_argument("--github", required=True, help="github-trending.json 路径")
    parser.add_argument("--news", required=True, help="news.json 路径")
    parser.add_argument("--output", required=True, help="输出 Markdown 文件路径")
    parser.add_argument(
        "--min-score",
        type=int,
        default=15,
        help="分类列表最低分阈值（默认 15）",
    )
    parser.add_argument(
        "--top-n",
        type=int,
        default=5,
        help="今日必读篇数（默认 5）",
    )
    args = parser.parse_args()

    # ── 加载数据 ──────────────────────────────────────────────────────────
    articles_meta = _load_json(args.articles)
    scored = _load_json(args.scored)
    trends = _load_json(args.trends)
    producthunt = _load_json(args.producthunt)
    github = _load_json(args.github)
    news_data = _load_json(args.news)

    if not isinstance(articles_meta, dict):
        print("错误: articles.json 应为 JSON 对象", file=sys.stderr)
        sys.exit(1)
    if not isinstance(scored, list):
        print("错误: scored.json 应为 JSON 数组", file=sys.stderr)
        sys.exit(1)

    # scored 按 totalScore 降序排列
    scored.sort(key=lambda x: _safe(x, "totalScore", 0), reverse=True)

    # ── 组装 Markdown ─────────────────────────────────────────────────────
    sections = [
        _build_header(articles_meta),
        _build_highlights(trends),
        _build_must_read(scored, args.top_n),
        _build_tech_section(scored, args.min_score, args.top_n),
        _build_product_section(
            producthunt, github, scored, args.min_score, args.top_n,
        ),
        _build_news_section(
            news_data, scored, args.min_score, args.top_n,
        ),
        _build_podcast_section(news_data),
        _build_other_section(scored, args.min_score, args.top_n),
    ]

    # 过滤空段落，组装最终 Markdown
    md = "\n".join(s for s in sections if s) + "\n"

    # ── 写入文件 ──────────────────────────────────────────────────────────
    try:
        os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(md)
    except OSError as exc:
        print(f"错误: 无法写入文件 – {args.output}: {exc}", file=sys.stderr)
        sys.exit(1)

    line_count = md.count("\n")
    size_kb = os.path.getsize(args.output) / 1024
    print(
        f"\u2705 每日要闻已生成: {args.output} ({line_count} 行, {size_kb:.1f} KB)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
