import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSummaryMarkdown, outDirHasArtifacts, persistSpokeResult, writeSpokeText } from "./output.js";
import { registerSecrets } from "./mask.js";
import type { AuditResult } from "./audit.js";
import type { ToolCallAudit } from "./tool-call-audit.js";
import type { SpokeRunResult } from "./types.js";

// output.ts 先前完全無測試覆蓋。plan_dispatch_v2.0.md §20：「多輪執行中撞一般 API 錯誤、
// 重試用盡、已有部分內容 → truncated:error（非 failed），且已完成輪次照落檔」——runner.ts
// 的狀態機部分已由 runner.test.ts 覆蓋（commit e8b2920，早於 v1.8 文件撰寫，plan 文件的
// 「待補」標記沒跟上），真正沒被驗證到的是「照落檔」這件事本身：writeSpokeText 對
// truncated:error 等非 failed 狀態是否真的把內容寫到磁碟。
//
// plan_i18n_impl_tickets T5／plan_i18n_v1.2.md §5.5／T3b＋T4 立的四條規矩：本檔函式皆已
// 加上 lang 參數。writeSpokeText／persistSpokeResult 的斷言不受語言影響（檢查的是檔案
// 是否存在、result.status 等未翻譯的原始值），一律傳 "zh" 即可；buildSummaryMarkdown 的
// 格式斷言（工具呼叫統計、清單外引用）才是本工單風險最高的部分，中英兩份都手寫字面量斷言，
// 且改用不對稱數字，讓「對調參數」的迴歸真的會紅。

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
    await writeSpokeText(dir, result.agent, result, "zh");
    const filePath = path.join(dir, `${result.agent}.md`);
    assert.ok(existsSync(filePath), "truncated:error 狀態應落檔");
    assert.equal(readFileSync(filePath, "utf8"), "round1 已經拿到的部分內容");
  });
});

test("writeSpokeText：failed 無產出 → 不落檔", async () => {
  await withTmpDir(async (dir) => {
    const result = mkResult({ status: "failed", finalText: null });
    await writeSpokeText(dir, result.agent, result, "zh");
    const filePath = path.join(dir, `${result.agent}.md`);
    assert.equal(existsSync(filePath), false, "failed 狀態不該落檔");
  });
});

// issue_log_v2.5.md 待修 #7：writeSpokeText 一度是唯一沒有遮蔽的落檔路徑。此測試守的是
// 「有沒有遮」，不是遮蔽演算法本身（那是 mask.test.ts 的事）。秘密字串刻意取得夠獨特，
// 避免 registerSecrets 的模組級狀態影響本檔其他測試的斷言。
test("writeSpokeText：finalText 經遮蔽才落檔（spoke 可能照抄被審專案裡的硬編金鑰）", async () => {
  await withTmpDir(async (dir) => {
    registerSecrets(["sk-writespoketext-should-be-masked"]);
    const result = mkResult({
      finalText: "原文：`const KEY = 'sk-writespoketext-should-be-masked'`",
    });
    await writeSpokeText(dir, result.agent, result, "zh");
    const written = readFileSync(path.join(dir, `${result.agent}.md`), "utf8");
    assert.equal(
      written.includes("sk-writespoketext-should-be-masked"),
      false,
      "落檔內容不得含未遮蔽的秘密",
    );
    assert.ok(written.includes("原文："), "遮蔽不應吃掉其餘內容");
  });
});

test("writeSpokeText：truncated:budget 等其他 truncated:* 狀態同樣照落檔", async () => {
  await withTmpDir(async (dir) => {
    const result = mkResult({ status: "truncated:budget", budgetTrigger: "total", finalText: "收束後的內容" });
    await writeSpokeText(dir, result.agent, result, "zh");
    assert.equal(readFileSync(path.join(dir, `${result.agent}.md`), "utf8"), "收束後的內容");
  });
});

test("writeSpokeText：非 failed 但 finalText 為 null（例如收束呼叫本身也失敗）時落檔佔位說明，而非留空或報錯", async () => {
  await withTmpDir(async (dir) => {
    const result = mkResult({ status: "truncated:error", finalText: null });
    await writeSpokeText(dir, result.agent, result, "zh");
    const content = readFileSync(path.join(dir, `${result.agent}.md`), "utf8");
    assert.match(content, /truncated:error/);
  });
});

test("writeSpokeText：非 failed 但 finalText 為 null 時，落檔內容依 lang 換語言（v1.2 §5.3：output.ts 加 lang 參數）", async () => {
  await withTmpDir(async (dir) => {
    const result = mkResult({ status: "truncated:error", finalText: null });
    await writeSpokeText(dir, result.agent, result, "en");
    const content = readFileSync(path.join(dir, `${result.agent}.md`), "utf8");
    assert.equal(content, "(Full report unavailable; execution status: truncated:error)");
  });
});

function mkAudit(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    finalLinePass: true,
    observationCount: 3,
    citedPaths: [],
    cannotVerifySectionPresent: true,
    templatePlaceholdersFound: [],
    ...overrides,
  };
}

function mkToolCallAudit(overrides: Partial<ToolCallAudit> = {}): ToolCallAudit {
  return { total: 2, allowed: 2, rejected: 0, allowedReadsCount: 5, zeroSourceRead: false, ...overrides };
}

// plan_dispatch_v2.0.md §15（一）：本版最優先項——素材為 issue_log_v2.0.md 2026-08-07
// 的真實案例，某次派工的兩支 spoke 零讀取但舊版稽核輸出全部 pass。
//
// T5 格式斷言規矩第 2 條：total／allowed／rejected 三個同型 number 參數餵不對稱的值
// （9／6／3，而非原本 2／2／0 這種容易被對調也看不出來的組合）；規矩第 1 條：期望值
// 手寫字面量，不透過 m() 重建；規矩末：中英兩份都斷言。
test("buildSummaryMarkdown：zeroSourceRead 時在稽核欄最前面顯眼標示，並附允許清單檔數（zh／en，手寫字面量，不對稱數字）", () => {
  const toolCallAudit = mkToolCallAudit({
    zeroSourceRead: true,
    allowedReadsCount: 35,
    total: 9,
    allowed: 6,
    rejected: 3,
  });
  const auditMap = new Map([["hole-finder-safety", mkAudit()]]);
  const toolCallMap = new Map([["hole-finder-safety", toolCallAudit]]);

  const mdZh = buildSummaryMarkdown(
    "t1",
    [mkResult({ agent: "hole-finder-safety" })],
    auditMap,
    toolCallMap,
    "zh",
  );
  assert.match(mdZh, /⚠ 零原始碼讀取（允許 35 檔）/);
  assert.match(mdZh, /工具呼叫:9（允許 6／拒絕 3）/);

  const mdEn = buildSummaryMarkdown(
    "t1",
    [mkResult({ agent: "hole-finder-safety" })],
    auditMap,
    toolCallMap,
    "en",
  );
  assert.match(mdEn, /⚠ Zero source reads \(allowed 35 file\(s\)\)/);
  assert.match(mdEn, /Tool calls:9 \(allowed 6 \/ rejected 3\)/);
});

test("buildSummaryMarkdown：非零讀取時不顯示警告，但仍顯示工具呼叫統計（zh／en，手寫字面量，不對稱數字）", () => {
  const toolCallAudit = mkToolCallAudit({ zeroSourceRead: false, total: 13, allowed: 8, rejected: 5 });
  const auditMap = new Map([["hole-finder-safety", mkAudit()]]);
  const toolCallMap = new Map([["hole-finder-safety", toolCallAudit]]);

  const mdZh = buildSummaryMarkdown(
    "t1",
    [mkResult({ agent: "hole-finder-safety" })],
    auditMap,
    toolCallMap,
    "zh",
  );
  assert.equal(mdZh.includes("⚠ 零原始碼讀取"), false);
  assert.match(mdZh, /工具呼叫:13（允許 8／拒絕 5）/);

  const mdEn = buildSummaryMarkdown(
    "t1",
    [mkResult({ agent: "hole-finder-safety" })],
    auditMap,
    toolCallMap,
    "en",
  );
  assert.equal(mdEn.includes("⚠ Zero source reads"), false);
  assert.match(mdEn, /Tool calls:13 \(allowed 8 \/ rejected 5\)/);
});

// 工單 X1 v1.1 §二：模板佔位符若被留在回報裡，列出是哪幾個、各幾次；§五、§六：稽核欄
// 由「收尾句／觀察／清單外引用／無法驗證欄／疑似禁止內容」5 格改為「收尾句／觀察／
// 無法驗證欄／佔位符」4 格。
test("buildSummaryMarkdown：佔位符欄列出命中的佔位符與次數（zh／en，手寫字面量）", () => {
  const auditMap = new Map([
    [
      "hole-finder-feasibility",
      mkAudit({
        templatePlaceholdersFound: [
          { placeholder: "<觀察>", count: 4 },
          { placeholder: "</觀察>", count: 2 },
        ],
      }),
    ],
  ]);
  const toolCallMap = new Map([["hole-finder-feasibility", mkToolCallAudit()]]);

  const mdZh = buildSummaryMarkdown(
    "t1",
    [mkResult({ agent: "hole-finder-feasibility" })],
    auditMap,
    toolCallMap,
    "zh",
  );
  assert.match(mdZh, /佔位符:<觀察>×4, <\/觀察>×2/);

  const mdEn = buildSummaryMarkdown(
    "t1",
    [mkResult({ agent: "hole-finder-feasibility" })],
    auditMap,
    toolCallMap,
    "en",
  );
  assert.match(mdEn, /Template placeholders:<觀察>×4, <\/觀察>×2/);
});

test("buildSummaryMarkdown：佔位符未命中時顯示無／none（既有風格）", () => {
  const auditMap = new Map([["hole-finder-cost", mkAudit({ templatePlaceholdersFound: [] })]]);
  const toolCallMap = new Map([["hole-finder-cost", mkToolCallAudit()]]);
  const mdZh = buildSummaryMarkdown("t1", [mkResult({ agent: "hole-finder-cost" })], auditMap, toolCallMap, "zh");
  assert.match(mdZh, /佔位符:無/);
  const mdEn = buildSummaryMarkdown("t1", [mkResult({ agent: "hole-finder-cost" })], auditMap, toolCallMap, "en");
  assert.match(mdEn, /Template placeholders:none/);
});

test("buildSummaryMarkdown：audit 與 toolCallAudit 皆缺失時仍印 (無法稽核)，不拋錯（防禦分支，zh／en）", () => {
  const mdZh = buildSummaryMarkdown("t1", [mkResult({ agent: "x" })], new Map(), new Map(), "zh");
  assert.match(mdZh, /\(無法稽核\)/);
  const mdEn = buildSummaryMarkdown("t1", [mkResult({ agent: "x" })], new Map(), new Map(), "en");
  assert.match(mdEn, /\(audit unavailable\)/);
});

// plan_dispatch_v2.6.md §26 規格四：hub 會讀的出口之一，放最前面顯眼標示，含 provider
// 名與 key 清單，且不依賴 audit／toolCallAudit 是否存在。
test("buildSummaryMarkdown：unknownUsageKeys 非空時最前面顯眼標示 provider 與 key 清單（v2.6 §26 規格四，zh／en）", () => {
  const results: SpokeRunResult[] = [
    mkResult({ agent: "hole-finder-cost", provider: "gemini", unknownUsageKeys: ["cachedContentTokenCount"] }),
  ];
  const mdZh = buildSummaryMarkdown("t1", results, new Map(), new Map(), "zh");
  assert.match(mdZh, /⚠ 未知 usage 欄位：gemini cachedContentTokenCount/);
  const mdEn = buildSummaryMarkdown("t1", results, new Map(), new Map(), "en");
  assert.match(mdEn, /⚠ Unknown usage field\(s\): gemini cachedContentTokenCount/);
});

test("buildSummaryMarkdown：unknownUsageKeys 為空陣列時不顯示警告", () => {
  const md = buildSummaryMarkdown(
    "t1",
    [mkResult({ agent: "hole-finder-cost", unknownUsageKeys: [] })],
    new Map(),
    new Map(),
    "zh",
  );
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
    await persistSpokeResult(dir, result, (m) => errors.push(m), "zh");
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
    await persistSpokeResult(dir, result, () => {}, "zh");
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
    await persistSpokeResult(dir, result, () => {}, "zh");
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
    await persistSpokeResult(dir, result, () => {}, "zh");
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
    await assert.doesNotReject(() => persistSpokeResult(missingDir, result, (m) => errors.push(m), "zh"));
    assert.equal(result.status, originalStatus, "落檔失敗不得改變 status");
    assert.equal(errors.length, 2, "writeSpokeText、writeRawFiles 各失敗一次，各回報一次 onError");
    assert.equal(result.errors.length, 2, "落檔失敗須留痕於 result.errors[]");
  });
});

test("persistSpokeResult：寫檔失敗時，錯誤訊息依 lang 換語言", async () => {
  await withTmpDir(async (dir) => {
    const missingDir = path.join(dir, "never-created");
    const result = mkResult({ status: "succeeded", finalText: "回報內容" });
    const errors: string[] = [];
    await persistSpokeResult(missingDir, result, (m) => errors.push(m), "en");
    assert.ok(errors.some((e) => e.startsWith(`Failed to write file (${result.agent}.md):`)));
    assert.ok(errors.some((e) => e.startsWith(`Failed to write file (${result.agent} raw/):`)));
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
    await persistSpokeResult(dir, first, () => {}, "zh");
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
    await persistSpokeResult(dir, rerun, () => {}, "zh");

    assert.deepEqual(
      JSON.parse(readFileSync(requestPath, "utf8")),
      [],
      "上一次的 raw 不得留存冒充本次證據（§13 重跑覆蓋語意）",
    );
  });
});

// fix_hosts #23：派工前的清場護欄。四格 host 對測抓到 hub 會自己 rm -rf 輸出目錄、
// 沒問任何人，而那底下是已付費的產物——判斷式本身放在 output.ts，中止動作在 cli.ts。
// 「讀不到就回 false」是刻意的：不存在該放行，權限不足交給 ensureOutDir 報更準的訊息。
test("outDirHasArtifacts：目錄不存在回 false", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "dispatch-outdir-"));
  assert.equal(await outDirHasArtifacts(path.join(base, "never-created")), false);
  rmSync(base, { recursive: true, force: true });
});

test("outDirHasArtifacts：空目錄回 false", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dispatch-outdir-"));
  assert.equal(await outDirHasArtifacts(dir), false);
  rmSync(dir, { recursive: true, force: true });
});

test("outDirHasArtifacts：有任何一個項目就回 true（含只有子目錄的情形）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dispatch-outdir-"));
  mkdirSync(path.join(dir, "raw"));
  assert.equal(await outDirHasArtifacts(dir), true, "只有 raw/ 也算有產物——那是上一次跑過的痕跡");

  const dir2 = mkdtempSync(path.join(tmpdir(), "dispatch-outdir-"));
  writeFileSync(path.join(dir2, "run.jsonl"), "", "utf8");
  assert.equal(await outDirHasArtifacts(dir2), true, "空的 run.jsonl 也算——它證明上一次真的跑過");

  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
});
