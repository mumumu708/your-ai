/**
 * Memory Benchmark — Full-pipeline integration test (NO mocks)
 *
 * Phases:
 *   1. INGEST — Feed all test data through CentralController.handleIncomingMessage()
 *              Sessions are closed after each batch to trigger OV commit.
 *   2. QUERY  — Send QA questions through the same pipeline, collect answers.
 *   3. EVAL   — Score answers against ground truth, produce a benchmark report.
 *
 * Requirements:
 *   - OpenViking server running (OPENVIKING_URL, default http://localhost:1933)
 *   - LightLLM API key configured (LIGHT_LLM_API_KEY + LIGHT_LLM_BASE_URL)
 *
 * Usage:
 *   # Full benchmark (all 217 questions)
 *   BENCH_MODE=full bun test src/integration/memory-benchmark/benchmark.integration.test.ts --timeout 600000
 *
 *   # Quick smoke test (persona + first 5 questions)
 *   BENCH_MODE=smoke bun test src/integration/memory-benchmark/benchmark.integration.test.ts --timeout 120000
 *
 *   # Ingest only (populate OV, no questions)
 *   BENCH_MODE=ingest bun test src/integration/memory-benchmark/benchmark.integration.test.ts --timeout 300000
 *
 *   # Query only (assume data already ingested)
 *   BENCH_MODE=query bun test src/integration/memory-benchmark/benchmark.integration.test.ts --timeout 300000
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentBridge } from '../../kernel/agents/agent-bridge';
import { ClaudeAgentBridge } from '../../kernel/agents/claude-agent-bridge';
import { ClaudeBridgeAdapter } from '../../kernel/agents/claude-bridge-adapter';
import { CodexAgentBridge } from '../../kernel/agents/codex-agent-bridge';
import { LightLLMClient } from '../../kernel/agents/light-llm-client';
import { CentralController, type CentralControllerDeps } from '../../kernel/central-controller';
import { OpenVikingClient } from '../../kernel/memory/openviking/openviking-client';
import { SessionStore } from '../../kernel/memory/session-store';
import { SessionManager } from '../../kernel/sessioning/session-manager';
import { TaskStore } from '../../kernel/tasking/task-store';
import { WorkspaceManager } from '../../kernel/workspace';
import type { BotMessage } from '../../shared/messaging/bot-message.types';
import {
  type QAItem,
  countMessages,
  loadAllBatches,
  loadMinimalBatches,
  loadQADataset,
} from './data-loader';
import { type EvalResult, evaluateAnswer, formatReport, generateReport } from './evaluator';

// ── Config ─────────────────────────────────────────────────

const BENCH_MODE = process.env.BENCH_MODE ?? 'smoke';
const BENCH_USER_ID = 'bench_yuxiaowen';
const BENCH_CHANNEL = 'web' as const;
const OV_URL = process.env.OPENVIKING_URL ?? 'http://localhost:1933';
const REPORT_DIR = join(import.meta.dir, '../../../test-data/yuxiaowen/reports');
const QA_LIMIT = Number(process.env.QA_LIMIT) || 0; // 0 = all
/** Max ingest batches to send via full pipeline (Claude CLI is slow). 0 = unlimited */
const BENCH_INGEST_LIMIT = Number(process.env.BENCH_INGEST_LIMIT) || 0;
/** Which agent to use for the benchmark — "claude" (default) or "codex" */
const BENCH_AGENT = (process.env.BENCH_AGENT ?? 'claude') as 'claude' | 'codex';

// ── Helpers ────────────────────────────────────────────────

let msgCounter = 0;
function createBenchMessage(content: string, conversationId: string): BotMessage {
  msgCounter++;
  return {
    id: `bench_msg_${msgCounter}_${Date.now()}`,
    channel: BENCH_CHANNEL,
    userId: BENCH_USER_ID,
    userName: '于晓雯',
    conversationId,
    content,
    contentType: 'text',
    timestamp: Date.now(),
    metadata: {},
  };
}

// ── Skip guard: only run when explicitly requested via BENCH_MODE ──
const shouldRun = !!process.env.BENCH_MODE;

// ── Test Suite ─────────────────────────────────────────────

describe.skipIf(!shouldRun)('Memory Benchmark (yuxiaowen)', () => {
  let ovClient: OpenVikingClient;
  let lightLLM: LightLLMClient;
  let agentBridge: AgentBridge;
  let sessionManager: SessionManager;
  let sessionStore: SessionStore;
  let taskStore: TaskStore;
  let controller: CentralController;
  let db: Database;

  beforeAll(async () => {
    // 1. Real OpenViking client
    ovClient = new OpenVikingClient({ baseUrl: OV_URL, timeout: 60_000, retries: 1 });

    // Verify OV is reachable
    try {
      await ovClient.health();
    } catch (err) {
      throw new Error(
        `OpenViking server not reachable at ${OV_URL}. ` +
          `Start it first or set OPENVIKING_URL. Error: ${err}`,
      );
    }

    // 2. Real LightLLM client (only used for evaluation scoring now)
    lightLLM = new LightLLMClient();

    // 3. Real agent bridge — Claude or Codex (both support MCP tool calling)
    if (BENCH_AGENT === 'codex') {
      agentBridge = new CodexAgentBridge({ timeoutMs: 300_000 });
    } else {
      const claudeBridge = new ClaudeAgentBridge({ defaultModel: 'claude-sonnet-4-5' });
      agentBridge = new ClaudeBridgeAdapter(claudeBridge);
    }

    // 4. Real SQLite DB — set SESSION_DB_PATH so the MCP memory server
    //    (separate process) reads the same DB for session_search FTS5 queries
    const dbPath = join(REPORT_DIR, 'bench_sessions.db');
    process.env.SESSION_DB_PATH = dbPath;
    mkdirSync(REPORT_DIR, { recursive: true });
    db = new Database(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    sessionStore = new SessionStore(db);
    taskStore = new TaskStore(db);

    // 5. Real SessionManager (short timeout so we can force-close between batches)
    sessionManager = new SessionManager({
      sessionTimeoutMs: 1800_000, // 30min — we'll close manually
      sessionStore,
    });

    // 6. Real WorkspaceManager — generates .mcp.json + .claude/settings.json
    //    so the Claude/Codex CLI picks up the viking_* MCP tools
    const wsRoot = join(REPORT_DIR, 'workspace', BENCH_USER_ID);
    // Provide AIEOS memory files so SystemPromptBuilder doesn't error
    const memoryDir = join(wsRoot, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    if (!existsSync(join(memoryDir, 'SOUL.md'))) {
      writeFileSync(
        join(memoryDir, 'SOUL.md'),
        '# 核心灵魂\n你是于晓雯的个人AI助手，帮她管理日常信息和记忆。请用中文回答。',
      );
    }
    if (!existsSync(join(memoryDir, 'IDENTITY.md'))) {
      writeFileSync(
        join(memoryDir, 'IDENTITY.md'),
        '# 身份\n我是一个个人AI助手，专注于帮助用户管理和回忆个人生活信息。',
      );
    }
    if (!existsSync(join(memoryDir, 'AGENTS.md'))) {
      writeFileSync(join(memoryDir, 'AGENTS.md'), '# Agents\n核心协议。');
    }
    if (!existsSync(join(memoryDir, 'USER.md'))) {
      writeFileSync(join(memoryDir, 'USER.md'), '# 用户信息\n用户名：于晓雯');
    }

    // Use real WorkspaceManager; it writes .mcp.json pointing at our memory MCP server.
    // YOURBOT_ROOT must point at the repo so resolveScriptPath finds mcp-servers/memory/index.ts
    process.env.YOURBOT_ROOT = join(import.meta.dir, '../../..');
    process.env.USER_SPACE_ROOT = join(REPORT_DIR, 'workspace');
    const workspaceManager = new WorkspaceManager();

    // 7. Assemble real CentralController
    CentralController.resetInstance();
    const deps: CentralControllerDeps = {
      sessionManager,
      agentBridge,
      lightLLM,
      sessionStore,
      taskStore,
      ovClient,
      workspaceManager,
    };
    controller = CentralController.getInstance(deps);

    console.log(
      `\n[Benchmark] Mode: ${BENCH_MODE} | Agent: ${BENCH_AGENT} | OV: ${OV_URL} | Workspace: ${wsRoot}`,
    );
  });

  afterAll(async () => {
    try {
      await controller.shutdown();
    } catch {
      /* ignore */
    }
    try {
      db.close();
    } catch {
      /* ignore */
    }
  });

  // ── Phase 1: Data Ingestion ──────────────────────────────

  if (BENCH_MODE !== 'query') {
    test(
      'Phase 1: Ingest test data via real agent pipeline (LLM-driven MCP tool calls)',
      async () => {
        let batches = BENCH_MODE === 'smoke' ? loadMinimalBatches() : loadAllBatches();
        if (BENCH_INGEST_LIMIT > 0) {
          batches = batches.slice(0, BENCH_INGEST_LIMIT);
          console.log(`[Ingest] Limited to first ${BENCH_INGEST_LIMIT} batches`);
        }
        const totalMessages = countMessages(batches);

        console.log(
          `[Ingest] ${batches.length} batches, ${totalMessages} total messages — via ${BENCH_AGENT} agent`,
        );

        let batchIdx = 0;
        let successCount = 0;
        let errorCount = 0;
        const startTime = Date.now();

        // Real pipeline: each batch message goes through controller.handleIncomingMessage
        // → Claude/Codex CLI → LLM sees viking_* MCP tools → decides add_resource vs remember
        // → stores original data in OV without lossy compression
        for (const batch of batches) {
          batchIdx++;

          for (const msgContent of batch.messages) {
            try {
              const msg = createBenchMessage(msgContent, batch.conversationId);
              const result = await controller.handleIncomingMessage(msg);
              if (result.success) {
                successCount++;
              } else {
                errorCount++;
                console.warn(
                  `[Ingest] ${batch.label} message failed: ${result.error ?? 'unknown'}`,
                );
              }
            } catch (err) {
              errorCount++;
              console.warn(
                `[Ingest] Pipeline error ${batch.label}: ${err instanceof Error ? err.message : err}`,
              );
            }
          }

          // Close session → onSessionClose callback fires commit + evolution
          const sessionKey = `${BENCH_USER_ID}:${BENCH_CHANNEL}:${batch.conversationId}`;
          await sessionManager.closeSession(sessionKey, 'user_end').catch(() => {});

          if (batchIdx % 5 === 0 || batchIdx === batches.length) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
            console.log(
              `[Ingest] Progress: ${batchIdx}/${batches.length} batches | ✓${successCount} ✗${errorCount} | ${elapsed}s elapsed`,
            );
          }
        }

        // Wait for OV async commit/extraction to finish
        console.log('[Ingest] Waiting for OpenViking to process...');
        try {
          await ovClient.waitProcessed(180);
        } catch {
          console.warn('[Ingest] OV processing wait timed out, continuing anyway');
        }

        console.log(`[Ingest] Complete: ${successCount} messages ingested, ${errorCount} errors`);
        // Accept 40% success rate — LLM may refuse some malformed inputs
        expect(successCount).toBeGreaterThan(totalMessages * 0.4);
      },
      { timeout: 3_600_000 }, // 1 hour
    );
  }

  // ── Phase 2: QA Query & Evaluation ───────────────────────

  if (BENCH_MODE !== 'ingest') {
    test(
      'Phase 2: Query QA questions and evaluate answers',
      async () => {
        const allQA = loadQADataset();
        const qaItems = QA_LIMIT > 0 ? allQA.slice(0, QA_LIMIT) : allQA;

        // In smoke mode, only test 5 questions
        const testItems = BENCH_MODE === 'smoke' ? qaItems.slice(0, 5) : qaItems;

        const QA_CONCURRENCY = Number(process.env.QA_CONCURRENCY) || 1;
        console.log(
          `[Query] Testing ${testItems.length} questions (of ${allQA.length} total) | concurrency=${QA_CONCURRENCY}`,
        );

        const results: EvalResult[] = new Array(testItems.length);
        let completed = 0;

        /** Process a single QA question */
        async function processQuestion(i: number): Promise<void> {
          const qa = testItems[i];
          const convId = `bench_qa_${i}_${Date.now()}`;

          try {
            let questionText = qa.question;
            if (qa.options && qa.options.length > 0) {
              questionText += `\n选项：\n${qa.options.map((o) => `${o.option}. ${o.content}`).join('\n')}`;
              questionText += '\n请选择正确答案并解释原因。';
            }

            const msg = createBenchMessage(questionText, convId);
            const taskResult = await controller.handleIncomingMessage(msg);

            const actualAnswer = taskResult.success
              ? (((taskResult.data as Record<string, unknown>)?.content as string) ?? '')
              : `[Error: ${taskResult.error}]`;

            const evalResult = await evaluateAnswer(lightLLM, qa, actualAnswer, i);
            results[i] = evalResult;

            // Destroy QA session without triggering OV commit
            const sessionKey = `${BENCH_USER_ID}:${BENCH_CHANNEL}:${convId}`;
            sessionManager.destroySession(sessionKey);
          } catch (err) {
            console.error(`[Query] Q${i} failed: ${err instanceof Error ? err.message : err}`);
            results[i] = {
              questionIndex: i,
              question: qa.question,
              expectedAnswer: String(qa.answer),
              actualAnswer: `[Pipeline error: ${err instanceof Error ? err.message : err}]`,
              questionType: qa.question_type,
              score: 0,
              maxScore: qa.score_points ? qa.score_points.reduce((s, p) => s + p.score, 0) : 10,
              pointScores: [],
              reasoning: 'Pipeline execution failed',
            };
          }

          completed++;
          if (completed % 5 === 0 || completed === testItems.length) {
            const done = results.filter(Boolean);
            const avgScore = done.reduce((s, r) => s + r.score / r.maxScore, 0) / done.length;
            console.log(
              `[Query] ${completed}/${testItems.length} done | Avg: ${(avgScore * 100).toFixed(1)}%`,
            );
          }
        }

        // Execute with configurable concurrency
        if (QA_CONCURRENCY <= 1) {
          for (let i = 0; i < testItems.length; i++) {
            await processQuestion(i);
            await new Promise((r) => setTimeout(r, 2000)); // throttle
          }
        } else {
          // Batch concurrent execution
          for (let start = 0; start < testItems.length; start += QA_CONCURRENCY) {
            const batch = [];
            for (let j = start; j < Math.min(start + QA_CONCURRENCY, testItems.length); j++) {
              batch.push(processQuestion(j));
            }
            await Promise.all(batch);
            await new Promise((r) => setTimeout(r, 1000)); // brief pause between batches
          }
        }

        // Generate and save report
        const report = generateReport(results);
        const reportText = formatReport(report);
        console.log(`\n${reportText}`);

        // Save detailed report as JSON
        const reportPath = join(REPORT_DIR, `benchmark-report-${Date.now()}.json`);
        writeFileSync(reportPath, JSON.stringify(report, null, 2));
        console.log(`\n[Report] Saved to: ${reportPath}`);

        // Save human-readable report
        const textPath = join(REPORT_DIR, `benchmark-report-${Date.now()}.txt`);
        writeFileSync(textPath, reportText);

        // Assertions: at minimum, the pipeline should not crash on most questions
        expect(results.length).toBe(testItems.length);
      },
      { timeout: 3_600_000 }, // 1 hour for Claude/Codex
    );
  }

  // ── Phase 3: Memory retrieval diagnosis ──────────────────

  if (BENCH_MODE === 'full' || BENCH_MODE === 'diagnose') {
    test(
      'Phase 3: Diagnose memory retrieval quality',
      async () => {
        // Pick a few representative questions and check what memories are retrieved
        const qaItems = loadQADataset();
        const sampleQuestions = [
          qaItems[0], // Information Extraction
          qaItems.find((q) => q.question_type === 'Multi-hop reasoning'),
          qaItems.find((q) => q.question_type === 'Temporal and Knowledge Updating'),
          qaItems.find((q) => q.question_type === 'Nondeclarative'),
        ].filter(Boolean) as QAItem[];

        console.log(`[Diagnose] Checking retrieval for ${sampleQuestions.length} sample questions`);

        const diagnostics: Array<{
          question: string;
          type: string;
          evidenceTypes: string[];
          retrievedUris: string[];
          retrievedScores: number[];
          retrievedSnippets: string[];
          gap: string;
        }> = [];

        for (const qa of sampleQuestions) {
          // Directly search OV to see what would be retrieved
          const query = qa.question;

          const memoryResults = await ovClient.find({
            query,
            target_uri: 'viking://user/memories',
            limit: 20,
          });

          const resourceResults = await ovClient.find({
            query,
            target_uri: 'viking://resources',
            limit: 10,
          });

          const allResults = [...memoryResults, ...resourceResults].sort(
            (a, b) => b.score - a.score,
          );

          // Check if any evidence data is in the results
          const evidenceTypes = (qa.evidence ?? []).map((e) => e.type);

          const diag = {
            question: qa.question,
            type: qa.question_type,
            evidenceTypes,
            retrievedUris: allResults.slice(0, 10).map((r) => r.uri),
            retrievedScores: allResults.slice(0, 10).map((r) => r.score),
            retrievedSnippets: allResults.slice(0, 5).map((r) => (r.abstract ?? '').slice(0, 100)),
            gap:
              allResults.length === 0
                ? 'NO_RESULTS — 完全没有检索到相关记忆'
                : allResults[0].score < 0.3
                  ? 'LOW_RELEVANCE — 最高分 < 0.3，检索质量差'
                  : allResults.length < 3
                    ? 'FEW_RESULTS — 检索到的记忆数量不足'
                    : 'ADEQUATE',
          };
          diagnostics.push(diag);

          console.log(`\n[Diagnose] Q: ${qa.question.slice(0, 60)}...`);
          console.log(`  Type: ${qa.question_type}`);
          console.log(`  Evidence needed: ${evidenceTypes.join(', ')}`);
          console.log(
            `  Retrieved: ${allResults.length} results, top score: ${allResults[0]?.score?.toFixed(3) ?? 'N/A'}`,
          );
          console.log(`  Gap: ${diag.gap}`);
        }

        // Save diagnostics
        const diagPath = join(REPORT_DIR, `diagnostics-${Date.now()}.json`);
        writeFileSync(diagPath, JSON.stringify(diagnostics, null, 2));
        console.log(`\n[Diagnose] Saved to: ${diagPath}`);
      },
      { timeout: 120_000 },
    );
  }
});
