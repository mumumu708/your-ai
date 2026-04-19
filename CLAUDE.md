# CLAUDE.md — Your-AI Engineering Guide

## Project Overview

Personal AI assistant platform with multi-channel access (Feishu/Telegram/Web) + 5-layer memory + self-evolution.
You are running in engineering mode — the current message has been classified as an engineering task (harness type).

## Core Work Discipline (Non-Negotiable)

1. After every code change, run `bun run check:all`
2. If any check fails, fix immediately and re-run until all pass
3. Only report completion after check:all passes entirely
4. Do not ask the admin "should I run tests?" — run them after every change, it's your job
5. If a new error pattern is discovered during this task, append it to `.harness/pitfalls.md`
6. Code and docs in the same branch, same commit — never "code first, docs later"

## .harness/ Documentation Update Discipline

After check:all passes, before committing, self-check each item:

- Added/removed modules or files? → Update `.harness/doc-source-map.json`
- Changed inter-module dependencies or layering? → Update `.harness/architecture.md`
- Introduced new coding patterns or conventions? → Update `.harness/conventions.md`
- Discovered new error patterns or pitfalls? → Append to `.harness/pitfalls.md`
- Made significant design decisions? → Add ADR in `.harness/design-docs/`
- Introduced new domain concepts or terminology? → Update `.harness/glossary.md`
- Changed testing strategy? → Update `.harness/testing.md`

After self-check, run `bun run check:docs` to verify documentation consistency.

## Key Commands

- Full check: `bun run check:all` (mandatory after every code change, includes coverage)
- Doc check: `bun run check:docs` (mandatory before commit)
- Test: `bun test`
- Lint: `bun run lint` / `bun run lint:fix`
- Format: `bun run format`
- Architecture check: `bun run check:arch`
- Coverage check: `bun run check:coverage`（Istanbul/nyc，提交前必跑）
- Mutation test: `bun run test:mutate`（Stryker-JS，测试闭环最后一环）
- Coverage HTML report: `bun run test:coverage:html`
- Create PR: `gh pr create --base main --head {branch} --title "..." --body "..."`

## Git Workflow

### Before Starting

1. `git status` — check if working tree is clean
2. If uncommitted changes exist: `git stash` (may be leftover from other tasks)
3. `git checkout main && git pull origin main` — ensure latest code
4. `git checkout -b agent/{type}/{short-description}`

### Branch Naming

- `agent/feat/memory-cache-layer` — New feature
- `agent/fix/telegram-timeout` — Bug fix
- `agent/refactor/memory-retriever` — Refactoring
- `agent/docs/update-architecture` — Documentation only

### Commit Convention (Conventional Commits)

```
feat: add memory cache layer
fix: fix Telegram channel timeout
refactor: restructure memory-retriever query logic
docs: update architecture.md memory module description
test: add cache-layer unit tests
chore: update doc-source-map.json
```

- One commit per logical unit (don't pile all changes into one commit)
- Code changes and corresponding `.harness/` doc updates go in the same commit
- Commit messages can be in Chinese or English, but stay consistent within a branch

### Multi-Step Task Commit Strategy

```
agent/feat/memory-cache-layer
├── commit 1: feat: add cache-layer.ts interface and implementation
├── commit 2: feat: integrate cache into memory-retriever
├── commit 3: test: add cache-layer unit tests
└── commit 4: docs: update architecture.md and doc-source-map
```

### After Completion

1. Confirm `bun run check:all` passes
2. Confirm `bun run check:docs` passes
3. `git push origin agent/{type}/{short-description}`
4. Create PR via GitHub CLI:

   ```bash
   gh pr create \
     --base main \
     --head agent/{type}/{short-description} \
     --title "{type}: {short description}" \
     --body "## What / Why
   {change description}

   ## Scope
   - {modules and files affected}

   ## Checklist
   - [x] bun run check:all passes
   - [x] bun run check:docs passes
   - [x] New features have tests
   - [ ] If config/ AIEOS files modified, user-side impact assessed
   - [ ] If new pitfalls found, .harness/pitfalls.md updated"
   ```

5. Notify admin: PR link, change summary, affected modules
6. Admin reviews and merges (merge / squash merge / rebase)

### PR Standards

- Title format matches commit message convention (`feat: xxx` / `fix: xxx`)
- Body must include What/Why and Checklist
- If PR contains multiple commits, list each commit's summary in the body
- If PR includes `.harness/` doc updates, note which documents were updated

### Prohibited Actions

- Do not commit directly to main branch
- Do not force push
- Do not modify files outside the current task scope (unless it's a discovered bug — log in pitfalls and fix in a separate branch)

## Architecture Overview

→ `.harness/architecture.md`

Five-layer architecture: Gateway → Kernel → Shared → UserSpace → Infra
Dependencies flow strictly downward.

## Layering Rules

- `gateway/` → may reference `kernel/` (public API), `shared/`
- `kernel/` → may reference `shared/`, must NOT reference `gateway/`
- `shared/` → zero dependencies (pure types/utilities)
- `mcp-servers/` → isolated via stdio

## Coding Conventions

→ `.harness/conventions.md`

## Common Pitfalls (Required Reading)

→ `.harness/pitfalls.md`

## Dual Context Model

This project has two contexts:

- `config/` AIEOS protocol = AI assistant's user-facing interaction behavior (copied to each user's user-space)
- `CLAUDE.md` + `.harness/` = Engineering development behavior (loaded only in harness mode)

Modifying files under `config/` requires extra caution — it directly impacts all users' experience.

## Design Documents

→ `.harness/design-docs/`

## Existing System Documentation

→ `docs/manifest.json`

## Operating Mode

You are running in headless (--print) mode.

- If the user's intent is not an engineering task (possible misclassification), respond as normal conversation
- Complex tasks (involving 3+ files): output a plan first, wait for admin confirmation before executing step by step
- After each step: auto-run check:all, then execute doc self-check checklist, finally check:docs
- Code + docs committed together, never separately

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- After modifying code files in this session, run `python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"` to keep the graph current
