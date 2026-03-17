#!/usr/bin/env python3
"""render-digest.py – 将 JSON 数据渲染为 Markdown 技术日报（零依赖）。

Usage:
    python3 render-digest.py \
        --articles articles.json \
        --scored scored.json \
        --trends trends.json \
        --output tech-digest-2026-03-14.md \
        --min-score 15 \
        --top-n 3
"""

from __future__ import annotations

import argparse
import collections
import datetime
import json
import math
import os
import sys

# ── 常量 ─────────────────────────────────────────────────────────────────────

CATEGORY_EMOJI = {
    "AI / ML": "\U0001f916",
    "Security": "\U0001f512",
    "Engineering": "\u2699\ufe0f",
    "Tools / Open Source": "\U0001f6e0",
    "Opinion / Misc": "\U0001f4a1",
    "Other": "\U0001f4dd",
}

CATEGORY_ORDER = [
    "AI / ML",
    "Security",
    "Engineering",
    "Tools / Open Source",
    "Opinion / Misc",
    "Other",
]

BAR_MAX_WIDTH = 16   # 关键词条形图最大宽度
KW_COL_WIDTH = 15    # 关键词列左对齐宽度
TOP_KW_COUNT = 10    # 高频关键词数量

# ── 工具函数 ──────────────────────────────────────────────────────────────────


def _load_json(path: str) -> object:
    """读取 JSON 文件，失败时打印友好错误并退出。"""
    if not os.path.isfile(path):
        print(f"错误: 文件不存在 – {path}", file=sys.stderr)
        sys.exit(1)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except json.JSONDecodeError as exc:
        print(f"错误: JSON 解析失败 – {path}: {exc}", file=sys.stderr)
        sys.exit(1)
    except OSError as exc:
        print(f"错误: 无法读取文件 – {path}: {exc}", file=sys.stderr)
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
        return fetched_at[:10] if len(fetched_at) >= 10 else "未知日期"


def _bar(count: int, max_count: int) -> str:
    """生成等比缩放的条形字符串。"""
    if max_count <= 0:
        return ""
    width = math.ceil(count / max_count * BAR_MAX_WIDTH)
    return "\u2588" * width


def _category_emoji(cat: str) -> str:
    return CATEGORY_EMOJI.get(cat, "\U0001f4dd")


# ── 构建各段 Markdown ─────────────────────────────────────────────────────────


def _build_header(articles_meta: dict, scored_count: int) -> str:
    date_str = _extract_date(_safe(articles_meta, "fetchedAt", ""))
    hours = _safe(articles_meta, "hoursWindow", "?")
    total_feeds = _safe(articles_meta, "totalFeeds", "?")
    filtered = _safe(articles_meta, "filteredByTime", "?")

    lines = [
        f"# \U0001f5de Tech Digest \u2014 \u6280\u672f\u65e5\u62a5 | {date_str}",
        "",
        f"> \U0001f4c5 \u65f6\u95f4\u7a97\u53e3\uff1a\u8fc7\u53bb {hours} \u5c0f\u65f6 | \U0001f4e1 \u6570\u636e\u6e90\uff1a{total_feeds} \u4e2a RSS \u6e90 | \U0001f4ca \u7b5b\u9009\uff1a{filtered} \u2192 {scored_count} \u7bc7\u8bc4\u5206",
        "",
        "---",
    ]
    return "\n".join(lines)


def _build_trends(trends: dict) -> str:
    lines = [
        "",
        "## \U0001f4dd \u4eca\u65e5\u770b\u70b9",
        "",
    ]
    highlights = _safe(trends, "highlights", "")
    if highlights:
        lines.append(highlights)
        lines.append("")

    trend_list = _safe(trends, "trends", [])
    if trend_list:
        lines.append("**\u8d8b\u52bf\u6d1e\u5bdf\uff1a**")
        lines.append("")
        for t in trend_list:
            lines.append(f"**{_safe(t, 'title')}**")
            lines.append("")
            desc = _safe(t, "description")
            if desc:
                lines.append(desc)
                lines.append("")

    lines.append("---")
    return "\n".join(lines)


def _build_must_read(scored: list, top_n: int) -> str:
    lines = [
        "",
        "## \U0001f3c6 \u4eca\u65e5\u5fc5\u8bfb",
        "",
    ]
    top_articles = scored[:top_n]
    for idx, art in enumerate(top_articles, 1):
        chinese_title = _safe(art, "chineseTitle", _safe(art, "title"))
        cat = _safe(art, "category", "Other")
        emoji = _category_emoji(cat)
        total = _safe(art, "totalScore", 0)
        rel = _safe(art, "pubDateRelative", "")
        source = _safe(art, "source", "")
        title = _safe(art, "title", "")
        link = _safe(art, "link", "")
        summary = _safe(art, "summary", "")
        rec = _safe(art, "recommendation", "")
        keywords = _safe(art, "keywords", [])

        lines.append(f"### {idx}. {chinese_title}")
        lines.append("")
        lines.append(
            f"> {emoji} {cat} | \u2b50 {total}/30 | \U0001f550 {rel} | \U0001f4cd {source}"
        )
        lines.append("")
        lines.append(f"**\u539f\u6587**: [{title}]({link})")
        lines.append("")
        if summary:
            lines.append(f"**\u6458\u8981**: {summary}")
            lines.append("")
        if rec:
            lines.append(f"**\u63a8\u8350\u7406\u7531**: {rec}")
            lines.append("")
        if keywords:
            kw_str = " ".join(f"`{k}`" for k in keywords)
            lines.append(f"**\u5173\u952e\u8bcd**: {kw_str}")
            lines.append("")

    lines.append("---")
    return "\n".join(lines)


def _build_stats(articles_meta: dict, scored: list) -> str:
    total_feeds = _safe(articles_meta, "totalFeeds", 0)
    success_feeds = _safe(articles_meta, "successFeeds", 0)
    total_articles = _safe(articles_meta, "totalArticles", 0)
    filtered = _safe(articles_meta, "filteredByTime", 0)
    scored_count = len(scored)
    avg_score = 0.0
    if scored_count > 0:
        avg_score = sum(_safe(a, "totalScore", 0) for a in scored) / scored_count

    lines = [
        "",
        "## \U0001f4ca \u6570\u636e\u6982\u89c8",
        "",
        "### \u7edf\u8ba1\u8868\u683c",
        "",
        "| \u6307\u6807 | \u6570\u636e |",
        "|------|------|",
        f"| \u6293\u53d6\u6e90\u6570 | {total_feeds} |",
        f"| \u6210\u529f\u6e90\u6570 | {success_feeds} |",
        f"| \u539f\u59cb\u6587\u7ae0\u6570 | {total_articles} |",
        f"| \u65f6\u95f4\u8fc7\u6ee4\u540e | {filtered} |",
        f"| AI \u8bc4\u5206\u7bc7\u6570 | {scored_count} |",
        f"| \u5e73\u5747\u8bc4\u5206 | {avg_score:.1f}/30 |",
    ]
    return "\n".join(lines)


def _build_category_pie(scored: list) -> str:
    counter: dict[str, int] = collections.Counter()
    for a in scored:
        counter[_safe(a, "category", "Other")] += 1

    lines = [
        "",
        "### \u5206\u7c7b\u5206\u5e03",
        "",
        "```mermaid",
        "pie title \u6587\u7ae0\u5206\u7c7b\u5206\u5e03",
    ]
    for cat in CATEGORY_ORDER:
        cnt = counter.get(cat, 0)
        if cnt > 0:
            lines.append(f'    "{cat}" : {cnt}')
    # 包含可能不在 CATEGORY_ORDER 里的分类
    for cat, cnt in sorted(counter.items()):
        if cat not in CATEGORY_ORDER and cnt > 0:
            lines.append(f'    "{cat}" : {cnt}')
    lines.append("```")
    return "\n".join(lines)


def _build_keyword_bar(scored: list) -> str:
    kw_counter: collections.Counter = collections.Counter()
    for a in scored:
        for k in _safe(a, "keywords", []):
            kw_counter[k] += 1

    top_kws = kw_counter.most_common(TOP_KW_COUNT)
    if not top_kws:
        return ""

    max_count = top_kws[0][1] if top_kws else 1

    lines = [
        "",
        "### Top 10 \u9ad8\u9891\u5173\u952e\u8bcd",
        "",
        "```",
    ]
    for kw, cnt in top_kws:
        bar = _bar(cnt, max_count)
        lines.append(f"{kw:<{KW_COL_WIDTH}} {bar} {cnt}")
    lines.append("```")
    return "\n".join(lines)


def _build_tag_cloud(scored: list) -> str:
    kw_counter: collections.Counter = collections.Counter()
    for a in scored:
        for k in _safe(a, "keywords", []):
            kw_counter[k] += 1

    if not kw_counter:
        return ""

    tags = []
    for kw, cnt in kw_counter.most_common():
        if cnt >= 5:
            tags.append(f"**#{kw}**")
        elif cnt >= 3:
            tags.append(f"*#{kw}*")
        else:
            tags.append(f"#{kw}")

    lines = [
        "",
        "### \u8bdd\u9898\u6807\u7b7e\u4e91",
        "",
        " ".join(tags),
    ]
    return "\n".join(lines)


def _build_category_articles(scored: list, min_score: int) -> str:
    filtered = [a for a in scored if _safe(a, "totalScore", 0) >= min_score]

    by_cat: dict[str, list] = collections.defaultdict(list)
    for a in filtered:
        by_cat[_safe(a, "category", "Other")].append(a)

    # 每个分类内按 totalScore 降序
    for cat in by_cat:
        by_cat[cat].sort(key=lambda x: _safe(x, "totalScore", 0), reverse=True)

    lines = [
        "",
        "---",
        "",
        "## \u5206\u7c7b\u6587\u7ae0\u5217\u8868",
    ]

    ordered_cats = list(CATEGORY_ORDER)
    for cat in by_cat:
        if cat not in ordered_cats:
            ordered_cats.append(cat)

    for cat in ordered_cats:
        arts = by_cat.get(cat, [])
        if not arts:
            continue
        emoji = _category_emoji(cat)
        lines.append("")
        lines.append(f"## {emoji} {cat}\uff08{len(arts)} \u7bc7\uff09")
        lines.append("")

        for a in arts:
            title = _safe(a, "title", "")
            link = _safe(a, "link", "")
            source = _safe(a, "source", "")
            rel = _safe(a, "pubDateRelative", "")
            total = _safe(a, "totalScore", 0)
            keywords = _safe(a, "keywords", [])
            chinese_title = _safe(a, "chineseTitle", "")
            summary = _safe(a, "summary", "")

            if chinese_title and summary:
                # 有摘要的文章（Top N）
                lines.append(f"### {chinese_title}")
                lines.append("")
                lines.append(
                    f"> [{title}]({link})"
                )
                lines.append(
                    f"> \U0001f4cd {source} | \U0001f550 {rel} | \u2b50 {total}/30"
                )
                lines.append("")
                lines.append(summary)
                lines.append("")
                if keywords:
                    kw_str = " ".join(f"`{k}`" for k in keywords)
                    lines.append(f"**\u5173\u952e\u8bcd**: {kw_str}")
                    lines.append("")
            else:
                # 没有摘要的文章
                kw_str = ""
                if keywords:
                    kw_str = " | " + " ".join(f"`{k}`" for k in keywords)
                lines.append(
                    f"- **[{title}]({link})** \u2014 \U0001f4cd {source} | \U0001f550 {rel} | \u2b50 {total}/30{kw_str}"
                )

    return "\n".join(lines)


# ── 主函数 ────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description="将 JSON 数据渲染为 Markdown 技术日报"
    )
    parser.add_argument("--articles", required=True, help="articles.json 路径")
    parser.add_argument("--scored", required=True, help="scored.json 路径")
    parser.add_argument("--trends", required=True, help="trends.json 路径")
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
        default=3,
        help="今日必读篇数（默认 3）",
    )
    args = parser.parse_args()

    # ── 加载数据 ──────────────────────────────────────────────────────────
    articles_meta = _load_json(args.articles)
    scored = _load_json(args.scored)
    trends = _load_json(args.trends)

    if not isinstance(articles_meta, dict):
        print("错误: articles.json 应为 JSON 对象", file=sys.stderr)
        sys.exit(1)
    if not isinstance(scored, list):
        print("错误: scored.json 应为 JSON 数组", file=sys.stderr)
        sys.exit(1)
    if not isinstance(trends, dict):
        print("错误: trends.json 应为 JSON 对象", file=sys.stderr)
        sys.exit(1)

    # scored 按 totalScore 降序排列
    scored.sort(key=lambda x: _safe(x, "totalScore", 0), reverse=True)

    # ── 组装 Markdown ─────────────────────────────────────────────────────
    sections = [
        _build_header(articles_meta, len(scored)),
        _build_trends(trends),
        _build_must_read(scored, args.top_n),
        _build_stats(articles_meta, scored),
        _build_category_pie(scored),
        _build_keyword_bar(scored),
        _build_tag_cloud(scored),
        _build_category_articles(scored, args.min_score),
        "",  # 尾部空行
    ]

    md = "\n".join(sections) + "\n"

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
        f"\u2705 \u65e5\u62a5\u5df2\u751f\u6210: {args.output} ({line_count} \u884c, {size_kb:.1f} KB)",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
