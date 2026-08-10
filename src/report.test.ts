import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, type CliOptions, type ProvidersSource } from "./report.js";
import type { ResolvedSpoke } from "./validate.js";
import type { AllowlistEstimate } from "./gate.js";

// plan_dispatch_v1.10.md §11：報表新增三行（repoRoot／providers 來源／gitignore 警告）。
// report.ts 先前無測試覆蓋，本輪一併補上。
//
// plan_dispatch_v2.0.md §14：新增「允許清單總量估算」獨立成行，只呈現不設閘門。

const SPOKE: ResolvedSpoke = {
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
};

const CLI: CliOptions = {
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
  json: false,
  dryRun: false,
  yes: false,
};

const BUNDLED: ProvidersSource = { kind: "bundled", formatVersion: 1 };
const ESTIMATES = [{ agent: SPOKE.agent, estimatedTokens: 100 }];
const NO_ALLOWLIST: AllowlistEstimate[] = [{ agent: SPOKE.agent, estimatedTokens: 0, fileCount: 0, sequential: { asListed: 0, sorted: 0 } }];

test("buildReport：repoRoot 明列於報表", () => {
  const report = buildReport("t1", [SPOKE], ESTIMATES, NO_ALLOWLIST, CLI, "tmp/spoke/t1", {
    repoRoot: "/Users/x/some-project",
    providersSource: BUNDLED,
    gitignoreStatus: "ignored",
  });
  assert.match(report, /repoRoot\s+\/Users\/x\/some-project/);
});

test("buildReport：providers 來源——出貨版本印 formatVersion", () => {
  const report = buildReport("t1", [SPOKE], ESTIMATES, NO_ALLOWLIST, CLI, "tmp/spoke/t1", {
    repoRoot: "/x",
    providersSource: BUNDLED,
    gitignoreStatus: "ignored",
  });
  assert.match(report, /providers\s+出貨（formatVersion 1）/);
});

test("buildReport：providers 來源——外部檔標明路徑", () => {
  const report = buildReport("t1", [SPOKE], ESTIMATES, NO_ALLOWLIST, CLI, "tmp/spoke/t1", {
    repoRoot: "/x",
    providersSource: { kind: "explicit", path: "/custom/providers.json", formatVersion: 1 },
    gitignoreStatus: "ignored",
  });
  assert.match(report, /providers\s+外部檔 \/custom\/providers\.json（formatVersion 1）/);
});

test("buildReport：gitignore 已涵蓋時不印警告", () => {
  const report = buildReport("t1", [SPOKE], ESTIMATES, NO_ALLOWLIST, CLI, "tmp/spoke/t1", {
    repoRoot: "/x",
    providersSource: BUNDLED,
    gitignoreStatus: "ignored",
  });
  assert.equal(report.includes("⚠"), false);
  assert.equal(report.includes("ℹ"), false);
});

test("buildReport：gitignore 未涵蓋時印 ⚠ 警告", () => {
  const report = buildReport("t1", [SPOKE], ESTIMATES, NO_ALLOWLIST, CLI, "tmp/spoke/t1", {
    repoRoot: "/x",
    providersSource: BUNDLED,
    gitignoreStatus: "not_ignored",
  });
  assert.match(report, /⚠ 輸出目錄 tmp\/spoke\/t1 未被輸出目錄所在的 git repo 忽略/);
});

test("buildReport：無法判定時印 ℹ 提示，措辭與警告不同（三態不得合併）", () => {
  const report = buildReport("t1", [SPOKE], ESTIMATES, NO_ALLOWLIST, CLI, "tmp/spoke/t1", {
    repoRoot: "/x",
    providersSource: BUNDLED,
    gitignoreStatus: "unknown",
  });
  assert.match(report, /ℹ 無法判定輸出目錄/);
  assert.equal(report.includes("⚠"), false);
});

test("buildReport：允許清單總量估算獨立成行，加總所有 spoke 的 tokens 與檔案數", () => {
  const allowlistEstimates: AllowlistEstimate[] = [
    { agent: "hole-finder-safety", estimatedTokens: 50_000, fileCount: 17, sequential: { asListed: 90_000, sorted: 60_000 } },
    { agent: "hole-finder-feasibility", estimatedTokens: 37_300, fileCount: 18, sequential: { asListed: 60_000, sorted: 40_000 } },
  ];
  const report = buildReport("t1", [SPOKE], ESTIMATES, allowlistEstimates, CLI, "tmp/spoke/t1", {
    repoRoot: "/x",
    providersSource: BUNDLED,
    gitignoreStatus: "ignored",
  });
  assert.match(report, /允許清單總量估算 87,300 tokens（35 檔）/);
});

// plan_dispatch_v2.4.md §14：允許清單估算行補口徑說明——上限估計、不去重、實測約
// 3.5 字元／token，避免這個數字被誤讀為預期消耗。
test("buildReport：允許清單總量估算附口徑說明（上限估計、不去重、實測字元／token 比）", () => {
  const allowlistEstimates: AllowlistEstimate[] = [
    { agent: "hole-finder-safety", estimatedTokens: 50_000, fileCount: 17, sequential: { asListed: 90_000, sorted: 60_000 } },
  ];
  const report = buildReport("t1", [SPOKE], ESTIMATES, allowlistEstimates, CLI, "tmp/spoke/t1", {
    repoRoot: "/x",
    providersSource: BUNDLED,
    gitignoreStatus: "ignored",
  });
  assert.match(report, /上限估計/);
  assert.match(report, /不去重/);
  assert.match(report, /3\.5 字元／token/);
});

test("buildReport：初始 prompt 估算那行不受允許清單估算影響——兩者是獨立的數字", () => {
  const allowlistEstimates: AllowlistEstimate[] = [{ agent: SPOKE.agent, estimatedTokens: 999_999, fileCount: 35, sequential: { asListed: 0, sorted: 0 } }];
  const report = buildReport("t1", [SPOKE], ESTIMATES, allowlistEstimates, CLI, "tmp/spoke/t1", {
    repoRoot: "/x",
    providersSource: BUNDLED,
    gitignoreStatus: "ignored",
  });
  assert.match(report, /初始 prompt 估算 100 tokens（僅 system prompt＋首則訊息，不含工單與允許清單；本閘門的估算上限 200,000）/);
});

test("buildReport：初始 prompt 估算行須明講不含工單與允許清單，避免被誤讀成整輪派工成本（plan_fixes_v1.0.md §3：實測差距 27 倍）", () => {
  const allowlistEstimates: AllowlistEstimate[] = [{ agent: SPOKE.agent, estimatedTokens: 999_999, fileCount: 35, sequential: { asListed: 0, sorted: 0 } }];
  const report = buildReport("t1", [SPOKE], ESTIMATES, allowlistEstimates, CLI, "tmp/spoke/t1", {
    repoRoot: "/x",
    providersSource: BUNDLED,
    gitignoreStatus: "ignored",
  });
  assert.match(report, /不含工單與允許清單/);
});

// issue_log_v2.1.md（第 8、9 次派工）：清單順序是 hub 唯一改得動的成本槓桿——大檔排第一
// 會被重送最多次。這幾則鎖住報表輸出：只驗「有沒有印」不夠，措辭與百分比都要鎖，否則
// 建議變成噪音而沒人照做。
test("buildReport：順序放大量與可省比例獨立成行，且百分比達門檻時印 ⚠", () => {
  const allowlistEstimates: AllowlistEstimate[] = [
    { agent: "hole-finder-safety", estimatedTokens: 1, fileCount: 3, sequential: { asListed: 100_000, sorted: 43_000 } },
  ];
  const report = buildReport("t1", [SPOKE], ESTIMATES, allowlistEstimates, CLI, "tmp/spoke/t1", {
    repoRoot: "/x",
    providersSource: BUNDLED,
    gitignoreStatus: "ignored",
  });
  assert.match(report, /逐個讀的順序放大量 100,000 tokens/);
  assert.match(report, /⚠ 大檔排清單最後可降至 43,000（本項省 57%）/);
});

// 口徑：這個百分比是「清單放大量」的節省，不是總成本的節省——初始 prompt 與工單不受排序
// 影響，會稀釋比例。實測第 8 次 feasibility：放大量省 64.6%，總成本只省 44.5%。不講清楚
// 會被讀成「總共省一半」。
test("buildReport：順序節省比例須標明不含初始 prompt 與工單，避免被讀成總成本節省", () => {
  const allowlistEstimates: AllowlistEstimate[] = [
    { agent: "hole-finder-safety", estimatedTokens: 1, fileCount: 3, sequential: { asListed: 100_000, sorted: 43_000 } },
  ];
  const report = buildReport("t1", [SPOKE], ESTIMATES, allowlistEstimates, CLI, "tmp/spoke/t1", {
    repoRoot: "/x",
    providersSource: BUNDLED,
    gitignoreStatus: "ignored",
  });
  assert.match(report, /不含初始 prompt 與工單/);
  assert.match(report, /總成本的節省比例低於此數/);
});

test("buildReport：順序已接近最佳時不印 ⚠，改用不同措辭（避免建議變成噪音）", () => {
  const allowlistEstimates: AllowlistEstimate[] = [
    { agent: "hole-finder-safety", estimatedTokens: 1, fileCount: 3, sequential: { asListed: 100_000, sorted: 99_000 } },
  ];
  const report = buildReport("t1", [SPOKE], ESTIMATES, allowlistEstimates, CLI, "tmp/spoke/t1", {
    repoRoot: "/x",
    providersSource: BUNDLED,
    gitignoreStatus: "ignored",
  });
  assert.match(report, /目前順序已接近最佳/);
  assert.equal(report.includes("⚠ 大檔排清單最後"), false);
});

test("buildReport：允許清單為空時不印順序放大量那幾行", () => {
  const report = buildReport("t1", [SPOKE], ESTIMATES, NO_ALLOWLIST, CLI, "tmp/spoke/t1", {
    repoRoot: "/x",
    providersSource: BUNDLED,
    gitignoreStatus: "ignored",
  });
  assert.equal(report.includes("逐個讀的順序放大量"), false);
});
