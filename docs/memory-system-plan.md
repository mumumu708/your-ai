# Memory System Rewrite Plan: SQLite+BM25 → OpenViking

## Context

The current memory system uses SQLite + in-memory Map + BM25 keyword search, which limits retrieval to exact keyword matching. The design doc (`docs/memory-system-design.md`) specifies a complete rewrite using **OpenViking Server** as the memory backend, enabling semantic vector search (Dense+Sparse via 火山引擎), L0/L1/L2 progressive context loading, and automated memory evolution. All references to the memory system must be updated synchronously.

---

## Phase 0: OpenViking Client SDK + Config Files

**Goal:** Build the standalone TypeScript SDK and AIEOS config templates.

### New Files:
| File | Description |
|------|-------------|
| `src/kernel/memory/openviking/types.ts` | Type definitions: `OVConfig`, `OVResponse`, `FindOptions`, `FindResult`, `MatchedContext`, `Session`, `FileEntry`, `Relation`, `MemoryCategory` |
| `src/kernel/memory/openviking/openviking-client.ts` | `OpenVikingClient` class: HTTP wrapper for all 37 endpoints (system, resources, FS, search, relations, sessions), retry with exponential backoff, zero deps |
| `src/kernel/memory/openviking/openviking-client.test.ts` | Unit tests with mocked fetch |
| `src/kernel/memory/openviking/index.ts` | Barrel exports |
| `src/setup/generate-ov-conf.ts` | Generates `ov.conf` from env vars (`VOLCENGINE_API_KEY`) |
| `config/SOUL.md` | Initial template with `## Lessons Learned` section |
| `config/IDENTITY.md` | Initial identity template |
| `config/USER.md` | Initial user profile template |
| `config/AGENTS.md` | Initial agents protocol template |

**No existing files modified.**

---

## Phase 1: ConfigLoader + Memory Retriever + Context Manager

**Goal:** Build new core modules alongside old code.

### New Files:
| File | Description |
|------|-------------|
| `src/kernel/memory/config-loader.ts` | `ConfigLoader` class: loads AIEOS files (local-first, VikingFS fallback), 1-min cache TTL, `updateUserProfile()`, `invalidate()` |
| `src/kernel/memory/config-loader.test.ts` | Tests for cache, local-first loading, fallback |
| `src/kernel/memory/memory-retriever-v2.ts` | `retrieveMemories()`: progressive L0→L1→L2 loading under token budget, parallel search across memories + resources via `ov.find()` |
| `src/kernel/memory/memory-retriever-v2.test.ts` | Tests for progressive loading, token budget allocation |
| `src/kernel/memory/context-manager.ts` | `ContextManager`: Pre-Compaction flush when tokens > 80%, calls `ov.commit()` + returns anchor text |
| `src/kernel/memory/context-manager.test.ts` | Tests |

**No existing files modified.**

---

## Phase 2: Evolution Engine + Lessons Learned + Graph

**Goal:** Build all new async modules.

### New Files:
| File | Description |
|------|-------------|
| `src/kernel/evolution/reflect.ts` | `reflect(ov, category)`: loads same-category memory abstracts, Claude extracts insights → writes to `semantic/` |
| `src/kernel/evolution/link.ts` | `linkMemory(ov, uri)`: finds similar memories via `ov.search()`, creates VikingFS links (score > 0.75) |
| `src/kernel/evolution/evolve.ts` | `evolveMemory(ov, newContent, existingUri)`: LLM classifies SUPERSEDE/SUPPLEMENT/CONTRADICT/DUPLICATE |
| `src/kernel/evolution/evolution-scheduler.ts` | Bunqueue async scheduler: `schedulePostCommit()`, concurrency=2, retries=1 |
| `src/lessons/error-detector.ts` | `detectErrorSignal()`: keyword patterns + repetition counter. Replaces current `CorrectionDetector` |
| `src/lessons/lesson-extractor.ts` | `extractLesson()`: LLM extracts `{ action, category, lesson, mergeTarget? }` |
| `src/lessons/lessons-updater.ts` | `LessonsLearnedUpdater`: parses/updates SOUL.md `## Lessons Learned` section, capacity control (20/category, 80 total), VikingFS sync |
| `src/lessons/manual-management.ts` | NL commands: "记住:...", "查看教训" |
| `src/kernel/memory/graph/entity-manager.ts` | `EntityManager`: `upsertEntity()`, `addRelation()`, `linkToMemory()`, `query(slug, depth)` |
| Tests for all above | ~600 lines total |

**No existing files modified.**

---

## Phase 3: Integration — Wire into CentralController

**Goal:** Replace old memory components with new ones. This is the critical switchover.

### Files to Modify:

#### `src/kernel/central-controller.ts` (Major)
- **Remove deps:** `memoryStore`, `memoryRetriever` (old BM25), `aieosProtocol`, `memoryLifecycleManager`
- **Add deps:** `ovClient` (OpenVikingClient), `configLoader`, `memoryRetrieverV2`, `contextManager`, `evolutionScheduler`, `lessonsUpdater`, `entityManager`
- **Rewrite constructor:** init `OpenVikingClient` from `OPENVIKING_URL` env var, init new deps
- **Rewrite `handleChatTask()`:** use new ConfigLoader + MemoryRetrieverV2 for context, add Pre-Compaction check, schedule evolution post-response
- **Rewrite session close callback:** `ov.commit(sessionId)` + evolution scheduling instead of `memoryStore.addSessionSummary()`

#### `src/kernel/evolution/knowledge-router.ts` (Medium)
- Swap `AieosProtocol` → `ConfigLoader` in `KnowledgeRouterDeps`
- Swap old `MemoryRetriever` → `MemoryRetrieverV2` (async `retrieveMemories()`)
- Rewrite `buildContext()`: `configLoader.loadAll()` loads all 4 files at once

#### `src/kernel/evolution/error-to-rule-pipeline.ts` (Medium)
- Delegate to new Lessons Learned pipeline (`LessonsLearnedUpdater` + error-detector)
- Remove `AieosProtocol` and `MemoryStore` deps

#### `src/kernel/evolution/post-response-analyzer.ts` (Small)
- Update `PostResponseAnalyzerDeps` to use new `LessonsLearnedUpdater` + new error detector

#### `src/kernel/evolution/correction-detector.ts` (Deprecate)
- Replaced by `src/lessons/error-detector.ts`

#### `src/kernel/sessioning/session-manager.ts` (Small)
- Update close flow: `onSessionClose` callback now triggers `ov.commit()` via CentralController
- `SessionMemoryExtractor` no longer used directly

#### `mcp-servers/memory/index.ts` (Major rewrite)
- Replace in-memory Map with `OpenVikingClient` calls
- `memory_store` → `ov.write()` to appropriate category URI
- `memory_search` → `ov.find()` with semantic search
- `memory_retrieve` → `ov.read(uri)`
- `memory_delete` → `ov.rm(uri)`

#### `src/kernel/memory/index.ts` (Small)
- Add exports for new modules, mark old ones `@deprecated`

#### `src/kernel/evolution/index.ts` (Small)
- Add exports for evolution scheduler, reflect, link, evolve

#### `ecosystem.config.js` (Small)
- Add `openviking-server` process entry

#### `.env.example` (Small)
- Add `OPENVIKING_URL=http://localhost:1933`, `VOLCENGINE_API_KEY`

### Integration Tests to Update:
- `src/integration/memory-pipeline.integration.test.ts` — mock OpenVikingClient, test new flow

---

## Phase 4: Cleanup + Migration + E2E

### New Files:
| File | Description |
|------|-------------|
| `src/setup/init-viking-dirs.ts` | Creates VikingFS directory structure (`viking://agent/config/`, `viking://user/memories/{facts,preferences,...}`, etc.) |
| `src/setup/migrate-sqlite-to-viking.ts` | Migrates existing SQLite memories to VikingFS (maps old categories to new URIs) |

### Files to Delete:
| File | Reason |
|------|--------|
| `src/kernel/memory/memory-store.ts` + test | Replaced by OpenVikingClient |
| `src/kernel/memory/memory-retriever.ts` + test | Replaced by memory-retriever-v2 |
| `src/kernel/memory/aieos-protocol.ts` + test | Replaced by config-loader |
| `src/kernel/memory/session-memory-extractor.ts` + test | Replaced by `ov.commit()` |
| `src/kernel/memory/working-memory.ts` + test | Replaced by OpenViking L0/L1/L2 |
| `src/kernel/evolution/memory-lifecycle-manager.ts` + test | Replaced by OpenViking dedup |
| `src/kernel/evolution/correction-detector.ts` + test | Replaced by `src/lessons/error-detector.ts` |

### Database Cleanup:
- Remove `memories` and `session_summaries` tables from `infra/database/schema.ts`
- Evaluate if `better-sqlite3`/`drizzle-orm` still needed for other tables

---

## Verification Plan

1. **Phase 0-2:** `bun test src/kernel/memory/openviking/ src/kernel/memory/config-loader.test.ts src/kernel/memory/memory-retriever-v2.test.ts src/kernel/memory/context-manager.test.ts src/lessons/ src/kernel/evolution/reflect.test.ts src/kernel/evolution/link.test.ts src/kernel/evolution/evolve.test.ts`
2. **Phase 3:** `bun test` — all tests pass (update mocks in integration tests)
3. **Phase 4 E2E:** Start OpenViking server (`openviking serve --config ov.conf`), run `bun test src/e2e/memory-e2e.test.ts` to verify full flow: message → context retrieval → respond → commit → memories stored → evolution scheduled
4. **Manual test:** Send chat message via Feishu/Web channel, verify memories persist across sessions via MCP memory tools
5. **If OpenViking docs are unclear:** reference https://github.com/volcengine/OpenViking/tree/main/docs for API details

---

## Implementation Order

```
Phase 0 (SDK + Config)    ──→  Phase 1 (Core Modules)  ──→  Phase 3 (Integration)  ──→  Phase 4 (Cleanup)
                          ──→  Phase 2 (Evolution/Lessons) ─↗
```

Phases 1 and 2 are independent and can be done in parallel. Phase 3 depends on both.
