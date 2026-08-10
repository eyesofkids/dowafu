import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSummaryMarkdown, persistSpokeResult, writeSpokeText } from "./output.js";
import type { AuditResult } from "./audit.js";
import type { ToolCallAudit } from "./tool-call-audit.js";
import type { SpokeRunResult } from "./types.js";

// output.ts 先前完全無測試覆蓋。plan_dispatch_v2.0.md §20：「多輪執行中撞一般 API 錯誤、
// 重試用盡、已有部分內容 → truncated:error（非 failed），且已完成輪次照落檔」——runner.ts
// 的狀態機部分已由 runner.test.ts 覆蓋（commit e8b2920，早於 v1.8 文件撰寫，plan 文件的
// 「待補」標記沒跟上），真正沒被驗證到的是「照落檔」這件事本身：writeSpokeText 對
// truncated:error 等非 failed 狀態是否真的把內容寫到磁碟。

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
    toolCalls: [],
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

function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "output-test-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("writeSpokeText：truncated:error 已有部分內容 → 照樣落檔（v1.6 §13 判定原則：已付費的內容不因未完成而消失）", async () => {
  await withTmpDir(async (dir) => {
    const result = mkResult({ status: "truncated:error", finalText: "round1 已經拿到的部分內容" });
    await writeSpokeText(dir, result.agent, result);
    const filePath = path.join(dir, `${result.agent}.md`);
    assert.ok(existsSync(filePath), "truncated:error 狀態應落檔");
    assert.equal(readFileSync(filePath, "utf8"), "round1 已經拿到的部分內容");
  });
});

test("writeSpokeText：failed 無產出 → 不落檔", async () => {
  await withTmpDir(async (dir) => {
    const result = mkResult({ status: "failed", finalText: null });
    await writeSpokeText(dir, result.agent, result);
    const filePath = path.join(dir, `${result.agent}.md`);
    assert.equal(existsSync(filePath), false, "failed 狀態不該落檔");
  });
});

test("writeSpokeText：truncated:budget 等其他 truncated:* 狀態同樣照落檔", async () => {
  await withTmpDir(async (dir) => {
    const result = mkResult({ status: "truncated:budget", budgetTrigger: "total", finalText: "收束後的內容" });
    await writeSpokeText(dir, result.agent, result);
    assert.equal(readFileSync(path.join(dir, `${result.agent}.md`), "utf8"), "收束後的內容");
  });
});

test("writeSpokeText：非 failed 但 finalText 為 null（例如收束呼叫本身也失敗）時落檔佔位說明，而非留空或報錯", async () => {
  await withTmpDir(async (dir) => {
    const result = mkResult({ status: "truncated:error", finalText: null });
    await writeSpokeText(dir, result.agent, result);
    const content = readFileSync(path.join(dir, `${result.agent}.md`), "utf8");
    assert.match(content, /truncated:error/);
  });
});

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
  return { total: 2, allowed: 2, rejected: 0, allowedReadsCount: 5, zeroSourceRead: false, ...overrides };
}

// plan_dispatch_v2.0.md §15（一）：本版最優先項——素材為 issue_log_v2.0.md 2026-08-07
// 的真實案例，某次派工的兩支 spoke 零讀取但舊版稽核輸出全部 pass。
test("buildSummaryMarkdown：zeroSourceRead 時在稽核欄最前面顯眼標示，並附允許清單檔數", () => {
  const md = buildSummaryMarkdown(
    "t1",
    [mkResult({ agent: "hole-finder-safety" })],
    new Map([["hole-finder-safety", mkAudit()]]),
    new Map([["hole-finder-safety", mkToolCallAudit({ zeroSourceRead: true, allowedReadsCount: 35, total: 2, allowed: 2, rejected: 0 })]]),
  );
  assert.match(md, /⚠ 零原始碼讀取（允許 35 檔）/);
  assert.match(md, /工具呼叫:2（允許 2／拒絕 0）/);
});

test("buildSummaryMarkdown：非零讀取時不顯示警告，但仍顯示工具呼叫統計", () => {
  const md = buildSummaryMarkdown(
    "t1",
    [mkResult({ agent: "hole-finder-safety" })],
    new Map([["hole-finder-safety", mkAudit()]]),
    new Map([["hole-finder-safety", mkToolCallAudit({ zeroSourceRead: false, total: 11, allowed: 11, rejected: 0 })]]),
  );
  assert.equal(md.includes("⚠ 零原始碼讀取"), false);
  assert.match(md, /工具呼叫:11（允許 11／拒絕 0）/);
});

// plan_dispatch_v2.0.md §15（二）
test("buildSummaryMarkdown：清單外引用附出現章節與疑似縮寫來源", () => {
  const md = buildSummaryMarkdown(
    "t1",
    [mkResult({ agent: "hole-finder-feasibility" })],
    new Map([
      [
        "hole-finder-feasibility",
        mkAudit({
          citedPathsOutsideAllowlist: ["[id]/sync/route.ts"],
          citedPathsOutsideAllowlistDetail: [
            {
              path: "[id]/sync/route.ts",
              section: "觀察",
              suffixOf: "app/api/property-management/external-ics/[id]/sync/route.ts",
            },
          ],
        }),
      ],
    ]),
    new Map([["hole-finder-feasibility", mkToolCallAudit()]]),
  );
  assert.match(
    md,
    /清單外引用:\[id\]\/sync\/route\.ts（「觀察」節；疑似 app\/api\/property-management\/external-ics\/\[id\]\/sync\/route\.ts 的縮寫）/,
  );
});

test("buildSummaryMarkdown：audit 與 toolCallAudit 皆缺失時仍印 (無法稽核)，不拋錯（防禦分支）", () => {
  const md = buildSummaryMarkdown("t1", [mkResult({ agent: "x" })], new Map(), new Map());
  assert.match(md, /\(無法稽核\)/);
});

// plan_dispatch_v2.6.md §26 規格四：hub 會讀的出口之一，放最前面顯眼標示，含 provider
// 名與 key 清單，且不依賴 audit／toolCallAudit 是否存在。
test("buildSummaryMarkdown：unknownUsageKeys 非空時最前面顯眼標示 provider 與 key 清單（v2.6 §26 規格四）", () => {
  const md = buildSummaryMarkdown(
    "t1",
    [mkResult({ agent: "hole-finder-cost", provider: "gemini", unknownUsageKeys: ["cachedContentTokenCount"] })],
    new Map(),
    new Map(),
  );
  assert.match(md, /⚠ 未知 usage 欄位：gemini cachedContentTokenCount/);
});

test("buildSummaryMarkdown：unknownUsageKeys 為空陣列時不顯示警告", () => {
  const md = buildSummaryMarkdown("t1", [mkResult({ agent: "hole-finder-cost", unknownUsageKeys: [] })], new Map(), new Map());
  assert.equal(md.includes("未知 usage 欄位"), false);
});

// plan_dispatch_v2.4.md §13（一）／§20：persistSpokeResult 是每支 spoke 完成即落檔的落地
// 點，落檔例外不得外傳（不拋、不改 status、須留痕）。

test("persistSpokeResult：非 failed 狀態寫出 .md 與 raw/ 兩檔", async () => {
  await withTmpDir(async (dir) => {
    mkdirSync(path.join(dir, "raw"));
    const result = mkResult({
      finalText: "回報內容",
      rawRequests: [{ a: 1 }],
      rawResponses: [{ b: 2 }],
    });
    const errors: string[] = [];
    await persistSpokeResult(dir, result, (m) => errors.push(m));
    assert.equal(readFileSync(path.join(dir, `${result.agent}.md`), "utf8"), "回報內容");
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "raw", `${result.agent}.request.json`), "utf8")), [{ a: 1 }]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "raw", `${result.agent}.response.json`), "utf8")), [{ b: 2 }]);
    assert.deepEqual(errors, []);
    assert.deepEqual(result.errors, []);
  });
});

test("persistSpokeResult：failed 狀態不寫 .md，仍寫 raw/（沿用 output.ts:52 既有語意）", async () => {
  await withTmpDir(async (dir) => {
    mkdirSync(path.join(dir, "raw"));
    const result = mkResult({ status: "failed", finalText: null, rawRequests: [], rawResponses: [] });
    await persistSpokeResult(dir, result, () => {});
    assert.equal(existsSync(path.join(dir, `${result.agent}.md`)), false);
    assert.ok(existsSync(path.join(dir, "raw", `${result.agent}.request.json`)));
    assert.ok(existsSync(path.join(dir, "raw", `${result.agent}.response.json`)));
  });
});

// plan_fixes_v1.0.md §6：失敗時 request/response 兩份原本都是 []，中斷或失敗原因沒有落點。
// errors.json 獨立於既有兩份之外，不改動它們「僅記成功輪次」的既有語意。
test("persistSpokeResult：rawErrors 落到獨立的 raw/<agent>.errors.json，不污染 request/response 兩份", async () => {
  await withTmpDir(async (dir) => {
    mkdirSync(path.join(dir, "raw"));
    const result = mkResult({
      status: "failed",
      finalText: null,
      rawRequests: [],
      rawResponses: [],
      rawErrors: [{ round: 1, status: 500, message: "internal error" }],
    });
    await persistSpokeResult(dir, result, () => {});
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "raw", `${result.agent}.request.json`), "utf8")), []);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "raw", `${result.agent}.response.json`), "utf8")), []);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "raw", `${result.agent}.errors.json`), "utf8")), [
      { round: 1, status: 500, message: "internal error" },
    ]);
  });
});

test("persistSpokeResult：無錯誤時 errors.json 仍落檔，內容為空陣列（非缺席）", async () => {
  await withTmpDir(async (dir) => {
    mkdirSync(path.join(dir, "raw"));
    const result = mkResult({ status: "succeeded", rawErrors: [] });
    await persistSpokeResult(dir, result, () => {});
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "raw", `${result.agent}.errors.json`), "utf8")), []);
  });
});

test("persistSpokeResult：寫檔失敗時不拋、不改 status、且呼叫 onError（本版核心，§13 規格一）", async () => {
  await withTmpDir(async (dir) => {
    // 刻意不建立 outDir/raw，讓 writeSpokeText 與 writeRawFiles 都因目錄不存在而失敗
    const missingDir = path.join(dir, "never-created");
    const result = mkResult({ status: "succeeded", finalText: "回報內容" });
    const originalStatus = result.status;
    const errors: string[] = [];
    await assert.doesNotReject(() => persistSpokeResult(missingDir, result, (m) => errors.push(m)));
    assert.equal(result.status, originalStatus, "落檔失敗不得改變 status");
    assert.equal(errors.length, 2, "writeSpokeText、writeRawFiles 各失敗一次，各回報一次 onError");
    assert.equal(result.errors.length, 2, "落檔失敗須留痕於 result.errors[]");
  });
});

// §13：raw 一律無條件覆寫，重跑同一輸出目錄時上一次的內容不得留存。
// （v2.4 實作期間曾有「空 raw 不覆蓋非空」的守衛與對應測試，驗收時一併撤除——
//  該守衛會讓重跑時零 raw 的 spoke 留著上一次的證據。詳見 issue_log_v2.0.md。）
test("writeRawFiles：重跑時零 raw 必須覆蓋掉上一次的內容，不得留存", async () => {
  await withTmpDir(async (dir) => {
    mkdirSync(path.join(dir, "raw"));
    const first = mkResult({
      status: "succeeded",
      finalText: "第一次",
      rawRequests: [{ 第一次: true }],
      rawResponses: [{ 第一次: true }],
    });
    await persistSpokeResult(dir, first, () => {});
    const requestPath = path.join(dir, "raw", `${first.agent}.request.json`);
    assert.deepEqual(JSON.parse(readFileSync(requestPath, "utf8")), [{ 第一次: true }]);

    // 重跑同一輸出目錄，這次該 spoke 第一輪就 failed，完全沒有 raw
    const rerun = mkResult({
      agent: first.agent,
      status: "failed",
      finalText: null,
      rawRequests: [],
      rawResponses: [],
    });
    await persistSpokeResult(dir, rerun, () => {});

    assert.deepEqual(
      JSON.parse(readFileSync(requestPath, "utf8")),
      [],
      "上一次的 raw 不得留存冒充本次證據（§13 重跑覆蓋語意）",
    );
  });
});
