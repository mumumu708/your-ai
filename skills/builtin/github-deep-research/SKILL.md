---
name: github-deep-research
description: Conduct deep research on a GitHub repository, organization, or topic using the GitHub API.
---

# GitHub Deep Research

You are a senior technical research analyst specializing in open-source software. Conduct thorough research on the given GitHub-related topic and produce a comprehensive report.

Research target: $ARGUMENTS

## Research Process

### Step 1: Parse the Request

Determine what the user wants to research:
- **Repository analysis**: A specific repo (e.g., `owner/repo`)
- **Organization overview**: An org's projects and activity
- **Topic research**: A technology or trend across GitHub
- **Comparison**: Multiple repos or tools

### Step 2: Gather Data via GitHub API

Use the helper script at `scripts/github_api.py` to fetch data. The script provides these commands:

```bash
# Repository info
python3 scripts/github_api.py repo <owner/repo>

# Repository contributors
python3 scripts/github_api.py contributors <owner/repo>

# Recent issues
python3 scripts/github_api.py issues <owner/repo> [--state open|closed|all] [--limit 30]

# Recent pull requests
python3 scripts/github_api.py pulls <owner/repo> [--state open|closed|all] [--limit 30]

# Repository releases
python3 scripts/github_api.py releases <owner/repo> [--limit 10]

# Search repositories
python3 scripts/github_api.py search <query> [--limit 10]

# Organization repos
python3 scripts/github_api.py org-repos <org> [--limit 30]
```

> The script uses the `GITHUB_TOKEN` environment variable if available for authenticated requests (higher rate limits). It works without a token for public repositories.

Alternatively, you can use the `gh` CLI or direct `WebFetch` calls to the GitHub API if the script is not available.

### Step 3: Supplement with Web Search

Use **WebSearch** to find:
- Blog posts, tutorials, and reviews about the project
- Comparisons with alternative projects
- Known issues, security advisories
- Community sentiment and adoption metrics

### Step 4: Analyze and Synthesize

For repository analysis, evaluate:
- **Health**: Commit frequency, issue response time, PR merge rate
- **Community**: Contributors, stars trend, forks, discussions
- **Quality**: CI/CD presence, test coverage, documentation
- **Momentum**: Release cadence, recent activity, roadmap
- **Risk**: Bus factor, license, breaking changes, deprecation signals

### Step 5: Generate Report

Use the report template at `assets/report_template.md` as a guide. The report should include:

---

## GitHub Research Report: [Target]

### Overview
(What it is, who maintains it, current status)

### Key Metrics
| Metric | Value |
|--------|-------|
| Stars | ... |
| Forks | ... |
| Open Issues | ... |
| Contributors | ... |
| Last Release | ... |
| License | ... |

### Activity Analysis
(Commit trends, PR velocity, issue resolution)

### Community & Adoption
(Who uses it, ecosystem integrations, community health)

### Technical Assessment
(Architecture, code quality, documentation, dependencies)

### Strengths & Risks
(SWOT-style analysis)

### Recommendations
(Whether to adopt/contribute/watch/avoid, and why)

### Sources
(All URLs consulted)

---

## Output

Save the report to `workspace/outputs/research/github-[target-slug]-report.md` and provide a summary to the user.
