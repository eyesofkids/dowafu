import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSummaryMarkdown, persistSpokeResultDb, readResults } from "./output.js";
import { m } from "./messages.js";
import { openDb } from "./db.js";
import { setProviderKey } from "./provider-key.js";
import { addSpoke, createTicket } from "./ticket-store.js";
import type { AuditResult } from "./audit.js";
import type { ToolCallAudit } from "./tool-call-audit.js";
import type { SpokeRunResult } from "./types.js";

const CLI_ENTRY = fileURLToPath(new URL("./cli.ts", import.meta.url));

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

type StoredResult = { output: string | null; request: string | null; response: string | null };

function withOutputDb(run: (db: ReturnType<typeof openDb>) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), "output-persist-test-"));
  try {
    run(openDb(path.join(root, "dowafu.db")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function readStoredResult(db: ReturnType<typeof openDb>, ticket: string, agent: string): StoredResult {
  return db.prepare(
    "SELECT output, request, response FROM results WHERE job_id = ? AND agent = ?",
  ).get(ticket, agent) as StoredResult;
}

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

test("persistSpokeResultDb：spoke 可能照抄被審專案裡的硬編金鑰，output 經遮蔽才寫入 DB", () => {
  const secret = "sk-outputmaskd1hot2-4a7f9c2e8b6d";
  withOutputDb((db) => {
    const result = mkResult({ finalText: `發現硬編金鑰：${secret}` });
    persistSpokeResultDb(db, "mask-output", result);
    const stored = readStoredResult(db, "mask-output", result.agent);
    assert.equal(stored.output?.includes(secret), false, "DB output 不得含未遮蔽的硬編金鑰");
    assert.match(stored.output ?? "", /\*\*\*REDACTED\*\*\*/);
  });
});

test("persistSpokeResultDb：request 與 response 的巢狀內容經遮蔽才寫入 DB", () => {
  const secret = "sk-deepmaskd1hot2-8c4a6f1e9b3d";
  withOutputDb((db) => {
    const result = mkResult({
      finalText: `spoke 回報 ${secret}`,
      rawRequests: [{ authorization: `Bearer ${secret}` }],
      rawErrors: [{ round: 1, status: 500, message: `request failed with ${secret}` }],
      rawResponses: [{ body: { apiKey: secret } }],
    });
    persistSpokeResultDb(db, "mask-deep", result);
    const stored = readStoredResult(db, "mask-deep", result.agent);
    assert.equal(stored.request?.includes(secret), false, "DB request 不得含未遮蔽的硬編金鑰");
    assert.equal(stored.response?.includes(secret), false, "DB response 不得含未遮蔽的硬編金鑰");
  });
});

test("persistSpokeResultDb：failed 沒有產出時 output 為 null", () => {
  withOutputDb((db) => {
    const result = mkResult({ status: "failed", finalText: "不得作為失敗產出寫入" });
    persistSpokeResultDb(db, "failed-output", result);
    assert.equal(readStoredResult(db, "failed-output", result.agent).output, null);
  });
});

test("persistSpokeResultDb：truncated:error 已有部分內容仍寫入（已付費的內容不因未完成而消失）", () => {
  withOutputDb((db) => {
    const result = mkResult({ status: "truncated:error", finalText: "round 1 已取得的部分回報" });
    persistSpokeResultDb(db, "truncated-output", result);
    assert.equal(readStoredResult(db, "truncated-output", result.agent).output, "round 1 已取得的部分回報");
  });
});

test("persistSpokeResultDb：truncated:budget 的已付費部分內容仍寫入 DB", () => {
  withOutputDb((db) => {
    const result = mkResult({
      status: "truncated:budget",
      budgetTrigger: "total",
      finalText: "預算截斷前已取得的內容",
    });
    persistSpokeResultDb(db, "truncated-budget-output", result);
    assert.equal(
      readStoredResult(db, "truncated-budget-output", result.agent).output,
      "預算截斷前已取得的內容",
    );
  });
});

test("persistSpokeResultDb：成功 result 的 output、request 與 response 都保留可檢視內容", () => {
  withOutputDb((db) => {
    const result = mkResult({
      finalText: "完整回報",
      rawRequests: [{ input: "first request" }],
      rawResponses: [{ output: "first response" }],
    });
    persistSpokeResultDb(db, "success-artifacts", result);
    const stored = readStoredResult(db, "success-artifacts", result.agent);
    assert.equal(stored.output, "完整回報");
    assert.deepEqual(JSON.parse(stored.request ?? ""), { requests: [{ input: "first request" }], errors: [] });
    const response = JSON.parse(stored.response ?? "") as { responses: unknown[]; result: SpokeRunResult };
    assert.deepEqual(response.responses, [{ output: "first response" }]);
    assert.equal(response.result.finalText, "完整回報");
  });
});

test("persistSpokeResultDb：failed result 不寫 output 仍保留 request、response 與 rawErrors", () => {
  withOutputDb((db) => {
    const result = mkResult({
      status: "failed",
      finalText: "不得作為 output",
      rawRequests: [{ input: "paid request" }],
      rawResponses: [{ output: "provider failure response" }],
      rawErrors: [{ round: 1, status: 500, message: "provider failure" }],
    });
    persistSpokeResultDb(db, "failed-artifacts", result);
    const stored = readStoredResult(db, "failed-artifacts", result.agent);
    assert.equal(stored.output, null);
    assert.deepEqual(JSON.parse(stored.request ?? ""), {
      requests: [{ input: "paid request" }],
      errors: [{ round: 1, status: 500, message: "provider failure" }],
    });
    const response = JSON.parse(stored.response ?? "") as { responses: unknown[] };
    assert.deepEqual(response.responses, [{ output: "provider failure response" }]);
  });
});

test("persistSpokeResultDb：沒有 rawErrors 時仍以空陣列持久化，不可省略欄位", () => {
  withOutputDb((db) => {
    const result = mkResult({ rawErrors: [] });
    persistSpokeResultDb(db, "empty-errors", result);
    const request = JSON.parse(readStoredResult(db, "empty-errors", result.agent).request ?? "") as {
      errors?: unknown[];
    };
    assert.deepEqual(request.errors, []);
    assert.equal(Object.hasOwn(request, "errors"), true);
  });
});

test("D1：已有 DB 結果時重派 exit 5，且 persistSpokeResultDb 不覆寫既有結果", () => {
  const root = mkdtempSync(path.join(tmpdir(), "output-db-rerun-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
    writeFileSync(path.join(root, ".claude", "agents", "hole-finder-cost.md"), "測試用 agent 定義");
    const db = openDb(dbPath);
    db.prepare("INSERT INTO providers (name, base_url, api, store, tool_calling, reasoning, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("deepseek", "https://example.test", "responses", 0, 1, JSON.stringify({ style: "openai", allowed: ["low"], default: "low" }), "2026-09-02T00:00:00.000Z");
    db.prepare("INSERT INTO models (provider, model, enabled, updated_at) VALUES (?, ?, ?, ?)").run("deepseek", "deepseek-v4-flash", 1, "2026-09-02T00:00:00.000Z");
    // 0.5.0 起 API key 只從 DB 讀（不再吃 DEEPSEEK_API_KEY 環境變數）。
    setProviderKey(db, "deepseek", "fake-key-never-used");
    createTicket(db, "sample", "# 待審段落\n內容\n", "zh");
    addSpoke(
      db,
      "sample",
      {
        agent: "hole-finder-cost",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        body: "# 具體問題\n1. 問題\n\n# 允許讀取\n",
      },
      "zh",
    );
    const first = mkResult({ finalText: "first paid result" });
    persistSpokeResultDb(db, "sample", first);
    assert.throws(
      () => persistSpokeResultDb(db, "sample", mkResult({ finalText: "must not overwrite" })),
      (err: unknown) => err instanceof Error && /constraint|unique/i.test(err.message),
    );
    assert.equal(
      (db.prepare("SELECT output FROM results WHERE job_id = ? AND agent = ?").get("sample", first.agent) as { output: string }).output,
      "first paid result",
    );

    const rerun = spawnSync("npx", ["tsx", CLI_ENTRY, "sample", "--db", dbPath, "--repo-root", root, "--yes"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DEEPSEEK_API_KEY: "fake-key-never-used", DISPATCH_HOME: root },
    });
    assert.equal(rerun.status, 5, `已有結果應在 API 前中止，stderr：${rerun.stderr}`);
    assert.equal(
      (db.prepare("SELECT output FROM results WHERE job_id = ? AND agent = ?").get("sample", first.agent) as { output: string }).output,
      "first paid result",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 票 skill-refresh：readResults 是 CLI 的 `dowafu result` 與 MCP 的 `dispatch_result`
// 共用的唯一查詢。兩條派工路徑寫進 results 的 job_id 不同——CLI 直接派工時是 ticket 名稱，
// 走 daemon 佇列時是 job 的 UUID——同一個指令都要拿得回來。

test("readResults：CLI 直接派工（job_id 就是 ticket 名稱）讀得回來，稽核表排在最前", () => {
  withOutputDb((db) => {
    const insert = db.prepare(
      "INSERT INTO results (job_id, agent, output, request, response, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL)",
    );
    insert.run("my-ticket", "hole-finder", "找到三個洞");
    insert.run("my-ticket", "__summary__", "稽核表內容");

    const lines = readResults(db, "my-ticket");
    assert.equal(lines.length, 2);
    // ORDER BY agent：底線排在字母前，稽核表因此永遠在最前面
    assert.ok(lines[0].startsWith("__summary__:"), `稽核表應排最前，實際：${lines[0]}`);
    assert.ok(lines[1].includes("找到三個洞"));
  });
});

test("readResults：走佇列時給 ticket 名稱也讀得回來（回頭找最近一筆完成的 job）", () => {
  withOutputDb((db) => {
    db.prepare(
      "INSERT INTO jobs (id, ticket, status, created_at, finished_at) VALUES (?, ?, 'completed', ?, ?)",
    ).run("job-uuid-old", "queued-ticket", "2026-09-01T00:00:00.000Z", "2026-09-01T01:00:00.000Z");
    db.prepare(
      "INSERT INTO jobs (id, ticket, status, created_at, finished_at) VALUES (?, ?, 'completed', ?, ?)",
    ).run("job-uuid-new", "queued-ticket", "2026-09-02T00:00:00.000Z", "2026-09-02T01:00:00.000Z");
    const insert = db.prepare(
      "INSERT INTO results (job_id, agent, output, request, response, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL)",
    );
    insert.run("job-uuid-old", "hole-finder", "舊的那一次");
    insert.run("job-uuid-new", "hole-finder", "最近那一次");

    const lines = readResults(db, "queued-ticket");
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("最近那一次"), `應取最近完成的那一筆，實際：${lines[0]}`);
  });
});

// 驗收熱修補（票 skill-docs）：回退查詢先前只找 `completed`，於是**失敗的佇列 job 用
// ticket-id 查不到**——實測回「No results found」，而那正是最想看結果的時候。
// interrupted 也要找得到：先完成的那幾支已經花過錢也已經落檔，把它們擋在外面與
// 「落檔失敗不得銷毀已付費結果」（D1-hot3）的立場相反。
//
// **running 必須查不到**，否則只放寬到「任何 job」的假實作也會過——那會把跑到一半的
// 半截結果當成最終答案端出去。
test("readResults：failed／interrupted 的佇列 job 給 ticket 名稱也讀得回來，running 不列入", () => {
  withOutputDb((db) => {
    const job = db.prepare("INSERT INTO jobs (id, ticket, status, created_at, finished_at) VALUES (?, ?, ?, ?, ?)");
    const insert = db.prepare(
      "INSERT INTO results (job_id, agent, output, request, response, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL)",
    );

    job.run("job-failed", "t-failed", "failed", "2026-09-01T00:00:00.000Z", "2026-09-01T01:00:00.000Z");
    insert.run("job-failed", "hole-finder", "失敗那次仍有這支的產出");
    assert.ok(readResults(db, "t-failed")[0]?.includes("失敗那次仍有這支的產出"), "failed 的 job 應該讀得回來");

    job.run("job-interrupted", "t-interrupted", "interrupted", "2026-09-01T00:00:00.000Z", "2026-09-01T01:00:00.000Z");
    insert.run("job-interrupted", "hole-finder", "中斷前已付費的那一支");
    assert.ok(readResults(db, "t-interrupted")[0]?.includes("中斷前已付費的那一支"), "interrupted 的 job 應該讀得回來");

    job.run("job-running", "t-running", "running", "2026-09-01T00:00:00.000Z", null);
    insert.run("job-running", "hole-finder", "還在跑，不該被當成最終答案");
    assert.deepEqual(readResults(db, "t-running"), [], "running 的 job 不該被 ticket 名稱查出來");
  });
});

test("readResults：查無結果回空陣列，不拋錯（呼叫端據此講人話）", () => {
  withOutputDb((db) => {
    assert.deepEqual(readResults(db, "never-dispatched"), []);
  });
});

// 工單 status-stdin §A-1（不變量 1／變異 1）：output IS NULL 是失敗訊號（見
// persistSpokeResultDb 對 status === "failed" 寫 NULL 的既有邏輯）。先前這裡印出
// `hole-finder-cost:\n`，付了錢卻拿到不完整的東西，看起來跟「這支什麼都沒說」一樣。
test("readResults：失敗的 spoke（output NULL）印出明確的失敗字樣，不是空白段落（zh／en）", () => {
  withOutputDb((db) => {
    const insert = db.prepare(
      "INSERT INTO results (job_id, agent, output, request, response, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL)",
    );
    insert.run("failed-run", "hole-finder-cost", null);

    const linesEn = readResults(db, "failed-run", "en");
    assert.equal(linesEn.length, 1);
    assert.equal(linesEn[0], `hole-finder-cost:\n${m("en", "noFullReportAvailable", "failed")}`);
    assert.notEqual(linesEn[0], "hole-finder-cost:\n", "不得印成空白段落");

    const linesZh = readResults(db, "failed-run", "zh");
    assert.equal(linesZh[0], `hole-finder-cost:\n${m("zh", "noFullReportAvailable", "failed")}`);
  });
});

// 不變量 2／變異 5：成功的 spoke 輸出逐字不變——本票不得因為要處理失敗案例而多包一層
// 或改動內容。用 assert.equal（不是 match）鎖住整行逐字相同，前後綴多包一層字元也會紅。
test("readResults：成功的 spoke 輸出逐字不變，不因本票改動多包一層（zh／en 都不受影響）", () => {
  withOutputDb((db) => {
    const insert = db.prepare(
      "INSERT INTO results (job_id, agent, output, request, response, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL)",
    );
    insert.run("succeeded-run", "hole-finder-cost", "觀察：找到一個問題\n<無法驗證>...</無法驗證>");

    assert.equal(readResults(db, "succeeded-run")[0], "hole-finder-cost:\n觀察：找到一個問題\n<無法驗證>...</無法驗證>");
    assert.equal(readResults(db, "succeeded-run", "zh")[0], "hole-finder-cost:\n觀察：找到一個問題\n<無法驗證>...</無法驗證>");
  });
});

// 工單 status-stdin §A-2（不變量 3／變異 2、3）：provider 自己回報的截斷（finishReason，
// 如 openai/deepseek 的 "incomplete"）先前稽核表一個字都不印——要自己去 DB 撈 JSON 才知道。
// 與我們自己的 truncated:budget（formatStatusCell 已印）分開判定，只在有東西可講時印。
test("buildSummaryMarkdown：provider 回報截斷時稽核表印得出來（finishReasonRaw 非 null 且非 stop，zh／en）", () => {
  const results = [mkResult({ agent: "hole-finder-cost", finishReason: "incomplete", finishReasonRaw: "incomplete" })];
  const mdZh = buildSummaryMarkdown("t1", results, new Map(), new Map(), "zh");
  assert.match(mdZh, /provider 回報截斷:incomplete/);
  const mdEn = buildSummaryMarkdown("t1", results, new Map(), new Map(), "en");
  assert.match(mdEn, /Provider-reported truncation:incomplete/);
});

test("buildSummaryMarkdown：正常結束（finishReason stop）不多印截斷欄（變異 3 的另一端：永遠截斷的假實作會被這條抓到）", () => {
  const results = [mkResult({ agent: "hole-finder-cost", finishReason: "stop", finishReasonRaw: "completed" })];
  const md = buildSummaryMarkdown("t1", results, new Map(), new Map(), "zh");
  assert.equal(md.includes("provider 回報截斷"), false);
});

test("buildSummaryMarkdown：finishReasonRaw 為 null（provider 沒給任何訊號）時不印截斷欄", () => {
  const results = [mkResult({ agent: "hole-finder-cost", finishReason: null, finishReasonRaw: null })];
  const md = buildSummaryMarkdown("t1", results, new Map(), new Map(), "zh");
  assert.equal(md.includes("provider 回報截斷"), false);
});
