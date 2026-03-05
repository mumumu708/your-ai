#!/usr/bin/env python3
"""
Self-contained GitHub API client for deep research.
Uses GITHUB_TOKEN env var if available; works without for public repos.

Usage:
    python3 github_api.py repo <owner/repo>
    python3 github_api.py contributors <owner/repo>
    python3 github_api.py issues <owner/repo> [--state open|closed|all] [--limit 30]
    python3 github_api.py pulls <owner/repo> [--state open|closed|all] [--limit 30]
    python3 github_api.py releases <owner/repo> [--limit 10]
    python3 github_api.py search <query> [--limit 10]
    python3 github_api.py org-repos <org> [--limit 30]
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime


API_BASE = "https://api.github.com"
TOKEN = os.environ.get("GITHUB_TOKEN", "")


def _headers():
    h = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "github-deep-research-skill",
    }
    if TOKEN:
        h["Authorization"] = f"Bearer {TOKEN}"
    return h


def _get(path, params=None):
    url = f"{API_BASE}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=_headers())
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else ""
        print(f"Error {e.code}: {e.reason}", file=sys.stderr)
        if body:
            try:
                detail = json.loads(body)
                print(f"  {detail.get('message', body)}", file=sys.stderr)
            except json.JSONDecodeError:
                print(f"  {body[:200]}", file=sys.stderr)
        sys.exit(1)


def _print_json(data):
    print(json.dumps(data, indent=2, ensure_ascii=False, default=str))


def cmd_repo(args):
    """Get repository information."""
    data = _get(f"/repos/{args.repo}")
    result = {
        "full_name": data["full_name"],
        "description": data.get("description"),
        "language": data.get("language"),
        "stars": data["stargazers_count"],
        "forks": data["forks_count"],
        "open_issues": data["open_issues_count"],
        "watchers": data["watchers_count"],
        "license": data.get("license", {}).get("spdx_id") if data.get("license") else None,
        "created_at": data["created_at"],
        "updated_at": data["updated_at"],
        "pushed_at": data["pushed_at"],
        "default_branch": data["default_branch"],
        "topics": data.get("topics", []),
        "homepage": data.get("homepage"),
        "archived": data.get("archived", False),
        "disabled": data.get("disabled", False),
        "size_kb": data.get("size"),
        "has_wiki": data.get("has_wiki"),
        "has_discussions": data.get("has_discussions"),
    }
    _print_json(result)


def cmd_contributors(args):
    """Get top contributors."""
    data = _get(f"/repos/{args.repo}/contributors", {"per_page": args.limit})
    result = [
        {
            "login": c["login"],
            "contributions": c["contributions"],
            "profile": c["html_url"],
        }
        for c in data
    ]
    _print_json(result)


def cmd_issues(args):
    """Get recent issues."""
    params = {
        "state": args.state,
        "per_page": args.limit,
        "sort": "updated",
        "direction": "desc",
    }
    data = _get(f"/repos/{args.repo}/issues", params)
    result = [
        {
            "number": i["number"],
            "title": i["title"],
            "state": i["state"],
            "labels": [l["name"] for l in i.get("labels", [])],
            "created_at": i["created_at"],
            "updated_at": i["updated_at"],
            "comments": i["comments"],
            "author": i["user"]["login"],
            "url": i["html_url"],
        }
        for i in data
        if "pull_request" not in i  # Exclude PRs from issues endpoint
    ]
    _print_json(result)


def cmd_pulls(args):
    """Get recent pull requests."""
    params = {
        "state": args.state,
        "per_page": args.limit,
        "sort": "updated",
        "direction": "desc",
    }
    data = _get(f"/repos/{args.repo}/pulls", params)
    result = [
        {
            "number": p["number"],
            "title": p["title"],
            "state": p["state"],
            "draft": p.get("draft", False),
            "created_at": p["created_at"],
            "updated_at": p["updated_at"],
            "merged_at": p.get("merged_at"),
            "author": p["user"]["login"],
            "url": p["html_url"],
            "additions": p.get("additions"),
            "deletions": p.get("deletions"),
        }
        for p in data
    ]
    _print_json(result)


def cmd_releases(args):
    """Get recent releases."""
    data = _get(f"/repos/{args.repo}/releases", {"per_page": args.limit})
    result = [
        {
            "tag": r["tag_name"],
            "name": r.get("name"),
            "published_at": r.get("published_at"),
            "prerelease": r["prerelease"],
            "draft": r["draft"],
            "author": r["author"]["login"],
            "url": r["html_url"],
            "body_excerpt": (r.get("body") or "")[:300],
        }
        for r in data
    ]
    _print_json(result)


def cmd_search(args):
    """Search repositories."""
    query = args.query
    params = {
        "q": query,
        "sort": "stars",
        "order": "desc",
        "per_page": args.limit,
    }
    data = _get("/search/repositories", params)
    result = [
        {
            "full_name": r["full_name"],
            "description": r.get("description"),
            "stars": r["stargazers_count"],
            "forks": r["forks_count"],
            "language": r.get("language"),
            "updated_at": r["updated_at"],
            "url": r["html_url"],
        }
        for r in data.get("items", [])
    ]
    _print_json({"total_count": data.get("total_count", 0), "items": result})


def cmd_org_repos(args):
    """Get organization repositories."""
    params = {
        "type": "public",
        "sort": "updated",
        "direction": "desc",
        "per_page": args.limit,
    }
    data = _get(f"/orgs/{args.org}/repos", params)
    result = [
        {
            "name": r["name"],
            "full_name": r["full_name"],
            "description": r.get("description"),
            "stars": r["stargazers_count"],
            "forks": r["forks_count"],
            "language": r.get("language"),
            "updated_at": r["updated_at"],
            "archived": r.get("archived", False),
        }
        for r in data
    ]
    _print_json(result)


def main():
    parser = argparse.ArgumentParser(description="GitHub API client for deep research")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # repo
    p = subparsers.add_parser("repo", help="Get repository info")
    p.add_argument("repo", help="owner/repo")
    p.set_defaults(func=cmd_repo)

    # contributors
    p = subparsers.add_parser("contributors", help="Get contributors")
    p.add_argument("repo", help="owner/repo")
    p.add_argument("--limit", type=int, default=20)
    p.set_defaults(func=cmd_contributors)

    # issues
    p = subparsers.add_parser("issues", help="Get issues")
    p.add_argument("repo", help="owner/repo")
    p.add_argument("--state", default="open", choices=["open", "closed", "all"])
    p.add_argument("--limit", type=int, default=30)
    p.set_defaults(func=cmd_issues)

    # pulls
    p = subparsers.add_parser("pulls", help="Get pull requests")
    p.add_argument("repo", help="owner/repo")
    p.add_argument("--state", default="open", choices=["open", "closed", "all"])
    p.add_argument("--limit", type=int, default=30)
    p.set_defaults(func=cmd_pulls)

    # releases
    p = subparsers.add_parser("releases", help="Get releases")
    p.add_argument("repo", help="owner/repo")
    p.add_argument("--limit", type=int, default=10)
    p.set_defaults(func=cmd_releases)

    # search
    p = subparsers.add_parser("search", help="Search repositories")
    p.add_argument("query", help="Search query")
    p.add_argument("--limit", type=int, default=10)
    p.set_defaults(func=cmd_search)

    # org-repos
    p = subparsers.add_parser("org-repos", help="Get org repos")
    p.add_argument("org", help="Organization name")
    p.add_argument("--limit", type=int, default=30)
    p.set_defaults(func=cmd_org_repos)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
