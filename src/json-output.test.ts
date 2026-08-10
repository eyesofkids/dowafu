import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJsonPayload, buildJsonPlan, buildJsonSpoke } from "./json-output.js";
import type { AuditResult } from "./audit.js";
import type { CliOptions } from "./report.js";
import type { ResolvedSpoke } from "./validate.js";
import type { SpokeRunResult } from "./types.js";
import type { ToolCallAudit } from "./tool-call-audit.js";

// plan_dispatch_v1.10.md §25：--json 契約的核心要求——observationCount 保留 number|null，
// 序列化時不得降級為 0（三個一定要做到的第 2 項）。
//
// plan_dispatch_v1.11.md §25：新增 mode／plan／gitignoreStatus。plan 在 dry-run／
// cancelled／executed 三種 mode 下都要有（與是否實際執行無關），spokes 維持「執行結果」
// 語意，dry-run／cancelled 時仍是空陣列——這是對的，不要改。
//
// plan_dispatch_v2.0.md §15（一）：zeroSourceRead 判定進 audit 物件；§14：allowlistEstimatedTokens／
// allowlistFileCount 進 plan 條目。

function mkResult(overrides: Partial<SpokeRunResult> = {}): SpokeRunResult {
  return {
    agent: "hole-finder-cost",
    provider: "deepseek",
    api: "responses",
    modelRequested: "deepseek-v4-flash",
    modelReturned: "deepseek-v4-flash",
    effort: "high",
    store: "false",
    status: "succeeded",
    finalText: "回報內容",
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, available: true },
    costUsd: null,
    finishReason: "stop",
    finishReasonRaw: "completed",
    toolCalls: [
      { path: "a.ts", allowed: true, startedAt: 0, durationMs: 1 },
      { path: "_docs/x.md", allowed: false, reason: "not_in_allowlist", startedAt: 0, durationMs: 1 },
    ],
    rateLimitHits: [],
    unknownUsageKeys: [],
    attempts: 1,
    errors: [],
    requestId: "req-1",
    startedAt: 0,
    finishedAt: 100,
    latencyMs: 100,
    waitedMs: 0,
    estimatedPromptTokens: 90,
    rawRequests: [],
    rawResponses: [],
    rawErrors: [],
    ...overrides,
  };
}

function mkAudit(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    finalLinePass: true,
    observationCount: 3,
    citedPaths: [],
    citedPathsOutsideAllowlist: [],
    citedPathsOutsideAllowlistDetail: [],
    cannotVerifySectionPresent: true,
    suspectPhrases: [],
    ...overrides,
  };
}

function mkToolCallAudit(overrides: Partial<ToolCallAudit> = {}): ToolCallAudit {
  return {
    total: 2,
    allowed: 1,
    rejected: 1,
    allowedReadsCount: 5,
    zeroSourceRead: false,
    ...overrides,
  };
}

test("buildJsonSpoke：toolCalls 統計 total/allowed/rejected 正確拆分", () => {
  const spoke = buildJsonSpoke(mkResult(), mkAudit(), mkToolCallAudit());
  assert.deepEqual(spoke.toolCalls, { total: 2, allowed: 1, rejected: 1 });
});

test("buildJsonSpoke：observationCount 為 null 時原樣保留，不得降級為 0（must-do #2）", () => {
  const spoke = buildJsonSpoke(mkResult(), mkAudit({ observationCount: null }), mkToolCallAudit());
  assert.equal(spoke.audit.observationCount, null);
  assert.notEqual(spoke.audit.observationCount, 0);
});

test("buildJsonSpoke：observationCount 為 0 時也原樣保留（與 null 可區分）", () => {
  const spoke = buildJsonSpoke(mkResult(), mkAudit({ observationCount: 0 }), mkToolCallAudit());
  assert.equal(spoke.audit.observationCount, 0);
});

test("buildJsonSpoke：budgetTrigger 未觸發時序列化為 null（不是 undefined，JSON.stringify 才不會丟掉這個欄位）", () => {
  const spoke = buildJsonSpoke(mkResult({ budgetTrigger: undefined }), mkAudit(), mkToolCallAudit());
  assert.equal(spoke.budgetTrigger, null);
  assert.equal(JSON.parse(JSON.stringify(spoke)).budgetTrigger, null);
});

test("buildJsonSpoke：budgetTrigger 有值時原樣帶出", () => {
  const spoke = buildJsonSpoke(
    mkResult({ status: "truncated:budget", budgetTrigger: "reasoning_round" }),
    mkAudit(),
    mkToolCallAudit(),
  );
  assert.equal(spoke.budgetTrigger, "reasoning_round");
});

test("buildJsonSpoke：audit 缺失（理論上不該發生，防禦分支）時 observationCount 仍為 null 而非 0", () => {
  const spoke = buildJsonSpoke(mkResult(), undefined, undefined);
  assert.equal(spoke.audit.observationCount, null);
});

// plan_dispatch_v2.0.md §15（一）：zeroSourceRead 判定須同步進 --json 的 audit 物件，
// 這樣消費端不必自己重算一次「toolCalls 是否全落在工單目錄內」。
test("buildJsonSpoke：zeroSourceRead 為 true 時寫入 audit 物件", () => {
  const spoke = buildJsonSpoke(mkResult(), mkAudit(), mkToolCallAudit({ zeroSourceRead: true }));
  assert.equal(spoke.audit.zeroSourceRead, true);
});

test("buildJsonSpoke：toolCallAudit 缺失（防禦分支）時 zeroSourceRead 為 false 而非拋錯", () => {
  const spoke = buildJsonSpoke(mkResult(), mkAudit(), undefined);
  assert.equal(spoke.audit.zeroSourceRead, false);
});

test("buildJsonPayload：整體結構，多個 spoke 各自映射，原文不進 JSON（無 finalText 欄位）", () => {
  const results = [mkResult({ agent: "a" }), mkResult({ agent: "b" })];
  const audits = new Map([
    ["a", mkAudit({ observationCount: null })],
    ["b", mkAudit({ observationCount: 5 })],
  ]);
  const toolCallAudits = new Map([
    ["a", mkToolCallAudit()],
    ["b", mkToolCallAudit()],
  ]);
  const payload = buildJsonPayload({
    ticketId: "t1",
    repoRoot: "/repo",
    outDir: "tmp/spoke/t1",
    providersSource: { kind: "bundled", formatVersion: 1 },
    mode: "executed",
    plan: [],
    gitignoreStatus: "ignored",
    results,
    audits,
    toolCallAudits,
    exitCode: 0,
  });
  assert.equal(payload.spokes.length, 2);
  assert.equal(payload.spokes[0].audit.observationCount, null);
  assert.equal(payload.spokes[1].audit.observationCount, 5);
  assert.ok(!("finalText" in payload.spokes[0]), "原文不得進入 JSON 契約");
});

test("buildJsonPayload：mode／gitignoreStatus 原樣帶出", () => {
  const payload = buildJsonPayload({
    ticketId: "t1",
    repoRoot: "/repo",
    outDir: "tmp/spoke/t1",
    providersSource: { kind: "bundled", formatVersion: 1 },
    mode: "dry-run",
    plan: [],
    gitignoreStatus: "not_ignored",
    results: [],
    audits: new Map(),
    toolCallAudits: new Map(),
    exitCode: 0,
  });
  assert.equal(payload.mode, "dry-run");
  assert.equal(payload.gitignoreStatus, "not_ignored");
});

test("buildJsonPayload：dry-run／cancelled 下 spokes 維持空陣列語意，但 plan 仍完整帶出（v1.11 §25 的重點）", () => {
  const plan = [
    {
      agent: "hole-finder-cost",
      provider: "deepseek",
      api: "responses",
      modelRequested: "deepseek-v4-flash",
      effort: "high",
      store: "false" as const,
      estimatedTokens: 900,
      cap: 400_000,
      allowlistEstimatedTokens: 12_000,
      allowlistFileCount: 4,
    },
  ];
  for (const mode of ["dry-run", "cancelled"] as const) {
    const payload = buildJsonPayload({
      ticketId: "t1",
      repoRoot: "/repo",
      outDir: "tmp/spoke/t1",
      providersSource: { kind: "bundled", formatVersion: 1 },
      mode,
      plan,
      gitignoreStatus: "ignored",
      results: [],
      audits: new Map(),
      toolCallAudits: new Map(),
      exitCode: 0,
    });
    assert.deepEqual(payload.spokes, [], `mode=${mode} 的 spokes 應為空陣列`);
    assert.deepEqual(payload.plan, plan, `mode=${mode} 的 plan 仍應完整帶出`);
  }
});

function mkResolvedSpoke(overrides: Partial<ResolvedSpoke> = {}): ResolvedSpoke {
  return {
    agent: "hole-finder-cost",
    provider: "deepseek",
    providerConfig: {
      baseURL: "https://api.deepseek.com/v1",
      api: "responses",
      store: false,
      toolCalling: true,
      reasoning: { style: "deepseek", allowed: ["high"], default: "high" },
      models: [],
      charsPerToken: null,
      tpmLimit: null,
      maxSpokeTokens: null,
    },
    model: "deepseek-v4-flash",
    effort: "high",
    agentBody: "test",
    questions: "1. test",
    allowSet: new Set<string>(),
    allowedReadsResolved: [],
    allowedReadsRelative: [],
    lang: "zh",
    ...overrides,
  };
}

const CLI_OPTIONS: CliOptions = {
  out: "tmp/spoke",
  concurrency: 2,
  maxTokens: 200_000,
  maxSpokeTokens: 400_000,
  timeoutSec: 300,
  retries: 2,
  rateLimitRetries: 5,
  maxRateWaitSec: 30,
  maxToolCalls: 30,
  charsPerToken: 1.0,
  maxSpokeReasoningTokens: 50_000,
  maxRoundReasoningTokens: null,
  json: true,
  dryRun: false,
  yes: false,
};

test("buildJsonPlan：把 ResolvedSpoke／估算／cap／允許清單估算映射成 plan 條目", () => {
  const spoke = mkResolvedSpoke();
  const plan = buildJsonPlan(
    [spoke],
    [{ agent: "hole-finder-cost", estimatedTokens: 828 }],
    // sequential 取自 gate.ts 的 SequentialReadEstimate 真實形狀（asListed／sorted 皆為
    // 已放大量估算，asListed >= sorted 恆成立，見 gate.test.ts）——buildJsonPlan 目前不讀
    // 這個欄位，但型別要求存在，不得塞空物件湊過型別檢查（issue_log_v2.1.md 2026-08-08
    // 「完成條件『四綠』有盲區」條目）。
    [{ agent: "hole-finder-cost", estimatedTokens: 12_000, fileCount: 4, sequential: { asListed: 30_000, sorted: 18_000 } }],
    CLI_OPTIONS,
  );
  assert.deepEqual(plan, [
    {
      agent: "hole-finder-cost",
      provider: "deepseek",
      api: "responses",
      modelRequested: "deepseek-v4-flash",
      effort: "high",
      store: "false",
      estimatedTokens: 828,
      cap: 400_000,
      allowlistEstimatedTokens: 12_000,
      allowlistFileCount: 4,
    },
  ]);
});

test("buildJsonPlan：store 為 n/a（gemini 一類無此參數的 provider）", () => {
  const spoke = mkResolvedSpoke({
    provider: "gemini",
    providerConfig: {
      baseURL: "https://generativelanguage.googleapis.com/v1beta",
      api: "gemini-native",
      store: null,
      toolCalling: true,
      reasoning: { style: "gemini", allowed: ["medium"], default: "medium" },
      models: [],
      charsPerToken: null,
      tpmLimit: null,
      maxSpokeTokens: null,
    },
  });
  const plan = buildJsonPlan(
    [spoke],
    [{ agent: "hole-finder-cost", estimatedTokens: 500 }],
    [],
    CLI_OPTIONS,
  );
  assert.equal(plan[0].store, "n/a");
});

test("buildJsonPlan：allowlistEstimates 缺對應 agent 時預設為 0（防禦分支）", () => {
  const spoke = mkResolvedSpoke();
  const plan = buildJsonPlan([spoke], [{ agent: "hole-finder-cost", estimatedTokens: 500 }], [], CLI_OPTIONS);
  assert.equal(plan[0].allowlistEstimatedTokens, 0);
  assert.equal(plan[0].allowlistFileCount, 0);
});
