import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, type CliOptions, type ProvidersSource } from "./report.js";
import type { ResolvedSpoke } from "./validate.js";
import type { AllowlistEstimate } from "./gate.js";

// plan_dispatch_v1.10.md §11：報表新增三行（repoRoot／providers 來源／gitignore 警告）。
// report.ts 先前無測試覆蓋，本輪一併補上。
//
// plan_dispatch_v2.0.md §14：新增「允許清單總量估算」獨立成行，只呈現不設閘門。
//
// plan_i18n_impl_tickets T5：buildReport 加 lang 參數，本檔既有斷言一律補上 "zh"
// （原文照舊，不受影響）；tpmPeakLine／initialPromptEstimate 這類 2 個以上同型參數的
// key，額外補一條中英手寫字面量斷言，且數字不對稱，才擋得住「參數對調」的迴歸。

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
    // v0.2.0：基礎 fixture 帶價目，因為那才是常態（出貨的 providers.json 每個型號都有）。
    // 缺價目是例外，另立 UNPRICED——否則每個測試的報表都會多一行缺價目警告，
    // 而下面「gitignore 已涵蓋時報表裡完全沒有 ⚠」那條斷言會被一個無關的警告打掉。
    // 數字沿用本檔慣例刻意不對稱，參數對調就會紅。
    pricing: { "deepseek-v4-flash": { inputPerM: 0.14, outputPerM: 0.28, cachedInputPerM: 0.0028 } },
    pricingAsOf: "2026-08-09",
  },
  model: "deepseek-v4-flash",
  effort: "high",
  agentBody: "test",
  questions: "1. test",
  allowSet: new Set<string>(),
  allowedReadsResolved: [],
  allowedReadsRelative: [],
  lang: "zh" as const,
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
  const report = buildReport(
    "t1",
    [SPOKE],
    ESTIMATES,
    NO_ALLOWLIST,
    CLI,
    "tmp/spoke/t1",
    { repoRoot: "/Users/x/some-project", providersSource: BUNDLED, gitignoreStatus: "ignored", reviewTextChars: 100, strayHeadings: [] },
    "zh",
  );
  assert.match(report, /repoRoot\s+\/Users\/x\/some-project/);
});

test("buildReport：providers 來源——出貨版本印 formatVersion", () => {
  const report = buildReport(
    "t1",
    [SPOKE],
    ESTIMATES,
    NO_ALLOWLIST,
    CLI,
    "tmp/spoke/t1",
    { repoRoot: "/x", providersSource: BUNDLED, gitignoreStatus: "ignored", reviewTextChars: 100, strayHeadings: [] },
    "zh",
  );
  assert.match(report, /providers\s+出貨（formatVersion 1）/);
});

test("buildReport：providers 來源——外部檔標明路徑", () => {
  const report = buildReport(
    "t1",
    [SPOKE],
    ESTIMATES,
    NO_ALLOWLIST,
    CLI,
    "tmp/spoke/t1",
    { repoRoot: "/x", providersSource: { kind: "explicit", path: "/custom/providers.json", formatVersion: 1 }, gitignoreStatus: "ignored", reviewTextChars: 100, strayHeadings: [] },
    "zh",
  );
  assert.match(report, /providers\s+外部檔 \/custom\/providers\.json（formatVersion 1）/);
});

test("buildReport：gitignore 已涵蓋時不印警告", () => {
  const report = buildReport(
    "t1",
    [SPOKE],
    ESTIMATES,
    NO_ALLOWLIST,
    CLI,
    "tmp/spoke/t1",
    { repoRoot: "/x", providersSource: BUNDLED, gitignoreStatus: "ignored", reviewTextChars: 100, strayHeadings: [] },
    "zh",
  );
  assert.equal(report.includes("⚠"), false);
  assert.equal(report.includes("ℹ"), false);
});

// 2026-08-15：待審段落疑似被切斷的警告。真實事故：tmp/dispatch 的 12 份 i18n 翻譯審查
// 工單待審段落被切成 25–248 字，$0.1780 全部無效，而當時報表上沒有任何一行提到這件事。
test("buildReport：strayHeadings 非空時印 ⚠ 警告，含待審段落字數與被切出的章節名（zh）", () => {
  const report = buildReport(
    "t1",
    [SPOKE],
    ESTIMATES,
    NO_ALLOWLIST,
    CLI,
    "tmp/spoke/t1",
    { repoRoot: "/x", providersSource: BUNDLED, gitignoreStatus: "ignored", reviewTextChars: 25, strayHeadings: ["工作流程規範"] },
    "zh",
  );
  assert.match(report, /⚠ _shared\.md 的「# 待審段落」只有 25 字，另有 1 個頂層章節：「# 工作流程規範」/);
  assert.match(report, /待審段落可能被它們切斷了/);
});

test("buildReport：strayHeadings 非空時印 ⚠ 警告（en）", () => {
  const report = buildReport(
    "t1",
    [SPOKE],
    ESTIMATES,
    NO_ALLOWLIST,
    CLI,
    "tmp/spoke/t1",
    { repoRoot: "/x", providersSource: BUNDLED, gitignoreStatus: "ignored", reviewTextChars: 25, strayHeadings: ["Workflow spec"] },
    "en",
  );
  assert.match(report, /⚠ _shared\.md's "# Under review" holds only 25 characters/);
  assert.match(report, /"# Workflow spec"/);
});

test("buildReport：strayHeadings 為空時完全不提（回歸：不得對正常工單製造雜訊）", () => {
  const report = buildReport(
    "t1",
    [SPOKE],
    ESTIMATES,
    NO_ALLOWLIST,
    CLI,
    "tmp/spoke/t1",
    { repoRoot: "/x", providersSource: BUNDLED, gitignoreStatus: "ignored", reviewTextChars: 12842, strayHeadings: [] },
    "zh",
  );
  assert.equal(report.includes("⚠"), false);
  assert.equal(report.includes("待審段落"), false);
});

test("buildReport：gitignore 未涵蓋時印 ⚠ 警告", () => {
  const report = buildReport(
    "t1",
    [SPOKE],
    ESTIMATES,
    NO_ALLOWLIST,
    CLI,
    "tmp/spoke/t1",
    { repoRoot: "/x", providersSource: BUNDLED, gitignoreStatus: "not_ignored", reviewTextChars: 100, strayHeadings: [] },
    "zh",
  );
  assert.match(report, /⚠ 輸出目錄 tmp\/spoke\/t1 未被輸出目錄所在的 git repo 忽略/);
});

test("buildReport：無法判定時印 ℹ 提示，措辭與警告不同（三態不得合併）", () => {
  const report = buildReport(
    "t1",
    [SPOKE],
    ESTIMATES,
    NO_ALLOWLIST,
    CLI,
    "tmp/spoke/t1",
    { repoRoot: "/x", providersSource: BUNDLED, gitignoreStatus: "unknown", reviewTextChars: 100, strayHeadings: [] },
    "zh",
  );
  assert.match(report, /ℹ 無法判定輸出目錄/);
  assert.equal(report.includes("⚠"), false);
});

test("buildReport：允許清單總量估算獨立成行，加總所有 spoke 的 tokens 與檔案數", () => {
  const allowlistEstimates: AllowlistEstimate[] = [
    { agent: "hole-finder-safety", estimatedTokens: 50_000, fileCount: 17, sequential: { asListed: 90_000, sorted: 60_000 } },
    { agent: "hole-finder-feasibility", estimatedTokens: 37_300, fileCount: 18, sequential: { asListed: 60_000, sorted: 40_000 } },
  ];
  const report = buildReport(
    "t1",
    [SPOKE],
    ESTIMATES,
    allowlistEstimates,
    CLI,
    "tmp/spoke/t1",
    { repoRoot: "/x", providersSource: BUNDLED, gitignoreStatus: "ignored", reviewTextChars: 100, strayHeadings: [] },
    "zh",
  );
  assert.match(report, /允許清單總量估算 87,300 tokens（35 檔）/);
});

// plan_dispatch_v2.4.md §14：允許清單估算行補口徑說明——上限估計、不去重、實測約
// 3.5 字元／token，避免這個數字被誤讀為預期消耗。
test("buildReport：允許清單總量估算附口徑說明（上限估計、不去重、實測字元／token 比）", () => {
  const allowlistEstimates: AllowlistEstimate[] = [
    { agent: "hole-finder-safety", estimatedTokens: 50_000, fileCount: 17, sequential: { asListed: 90_000, sorted: 60_000 } },
  ];
  const report = buildReport(
    "t1",
    [SPOKE],
    ESTIMATES,
    allowlistEstimates,
    CLI,
    "tmp/spoke/t1",
    { repoRoot: "/x", providersSource: BUNDLED, gitignoreStatus: "ignored", reviewTextChars: 100, strayHeadings: [] },
    "zh",
  );
  assert.match(report, /上限估計/);
  assert.match(report, /不去重/);
  assert.match(report, /3\.5 字元／token/);
});

test("buildReport：初始 prompt 估算那行不受允許清單估算影響——兩者是獨立的數字（zh，totalEst／maxTokens 不對稱手寫字面量）", () => {
  const allowlistEstimates: AllowlistEstimate[] = [{ agent: SPOKE.agent, estimatedTokens: 999_999, fileCount: 35, sequential: { asListed: 0, sorted: 0 } }];
  const report = buildReport(
    "t1",
    [SPOKE],
    ESTIMATES,
    allowlistEstimates,
    CLI,
    "tmp/spoke/t1",
    { repoRoot: "/x", providersSource: BUNDLED, gitignoreStatus: "ignored", reviewTextChars: 100, strayHeadings: [] },
    "zh",
  );
  assert.match(report, /初始 prompt 估算 100 tokens（僅 system prompt＋首則訊息，不含工單與允許清單；本閘門的估算上限 200,000）/);
});

test("buildReport：初始 prompt 估算行須明講不含工單與允許清單，避免被誤讀成整輪派工成本（plan_fixes_v1.0.md §3：實測差距 27 倍）", () => {
  const allowlistEstimates: AllowlistEstimate[] = [{ agent: SPOKE.agent, estimatedTokens: 999_999, fileCount: 35, sequential: { asListed: 0, sorted: 0 } }];
  const report = buildReport(
    "t1",
    [SPOKE],
    ESTIMATES,
    allowlistEstimates,
    CLI,
    "tmp/spoke/t1",
    { repoRoot: "/x", providersSource: BUNDLED, gitignoreStatus: "ignored", reviewTextChars: 100, strayHeadings: [] },
    "zh",
  );
  assert.match(report, /不含工單與允許清單/);
});

// issue_log_v2.1.md（第 8、9 次派工）：清單順序是 hub 唯一改得動的成本槓桿——大檔排第一
// 會被重送最多次。這幾則鎖住報表輸出：只驗「有沒有印」不夠，措辭與百分比都要鎖，否則
// 建議變成噪音而沒人照做。
test("buildReport：順序放大量與可省比例獨立成行，且百分比達門檻時印 ⚠", () => {
  const allowlistEstimates: AllowlistEstimate[] = [
    { agent: "hole-finder-safety", estimatedTokens: 1, fileCount: 3, sequential: { asListed: 100_000, sorted: 43_000 } },
  ];
  const report = buildReport(
    "t1",
    [SPOKE],
    ESTIMATES,
    allowlistEstimates,
    CLI,
    "tmp/spoke/t1",
    { repoRoot: "/x", providersSource: BUNDLED, gitignoreStatus: "ignored", reviewTextChars: 100, strayHeadings: [] },
    "zh",
  );
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
  const report = buildReport(
    "t1",
    [SPOKE],
    ESTIMATES,
    allowlistEstimates,
    CLI,
    "tmp/spoke/t1",
    { repoRoot: "/x", providersSource: BUNDLED, gitignoreStatus: "ignored", reviewTextChars: 100, strayHeadings: [] },
    "zh",
  );
  assert.match(report, /不含初始 prompt 與工單/);
  assert.match(report, /總成本的節省比例低於此數/);
});

test("buildReport：順序已接近最佳時不印 ⚠，改用不同措辭（避免建議變成噪音）", () => {
  const allowlistEstimates: AllowlistEstimate[] = [
    { agent: "hole-finder-safety", estimatedTokens: 1, fileCount: 3, sequential: { asListed: 100_000, sorted: 99_000 } },
  ];
  const report = buildReport(
    "t1",
    [SPOKE],
    ESTIMATES,
    allowlistEstimates,
    CLI,
    "tmp/spoke/t1",
    { repoRoot: "/x", providersSource: BUNDLED, gitignoreStatus: "ignored", reviewTextChars: 100, strayHeadings: [] },
    "zh",
  );
  assert.match(report, /目前順序已接近最佳/);
  assert.equal(report.includes("⚠ 大檔排清單最後"), false);
});

test("buildReport：允許清單為空時不印順序放大量那幾行", () => {
  const report = buildReport(
    "t1",
    [SPOKE],
    ESTIMATES,
    NO_ALLOWLIST,
    CLI,
    "tmp/spoke/t1",
    { repoRoot: "/x", providersSource: BUNDLED, gitignoreStatus: "ignored", reviewTextChars: 100, strayHeadings: [] },
    "zh",
  );
  assert.equal(report.includes("逐個讀的順序放大量"), false);
});

// 語言是工單標記推出來的，不是使用者填的——所以它必須印在報表上。看得見才擋得住
// 「英文問題被判成中文工單」這種在花錢之前唯一能發現的錯。
test("buildReport：每個 spoke 印出解析到的語言", () => {
  const meta = { repoRoot: "/repo", providersSource: BUNDLED, gitignoreStatus: "ignored" as const, reviewTextChars: 100, strayHeadings: [] };
  const zh = buildReport("t1", [SPOKE], ESTIMATES, NO_ALLOWLIST, CLI, "tmp/spoke/t1", meta, "zh");
  assert.match(zh, /lang=zh/);

  const enSpoke = { ...SPOKE, lang: "en" as const };
  const en = buildReport("t1", [enSpoke], ESTIMATES, NO_ALLOWLIST, CLI, "tmp/spoke/t1", meta, "en");
  assert.match(en, /lang=en/);
});

// plan_i18n_impl_tickets T5 格式斷言第 2／4 條：tpmPeakLine 是本檔唯一有 3 個同型 string
// 參數（provider／limit／peak，limit 與 peak 皆為已格式化字串）的 key，且先前完全沒有
// 測試覆蓋（既有 SPOKE.providerConfig.tpmLimit 恆為 null，從未進過這個分支）。用差距懸殊
// 的 limit／peak（500,000 對 321）確保對調會被抓到；連同其餘多數字組合的 key
// （initialPromptEstimate／allowlistTotalEstimate／sequentialReadCanReduce）一併驗英文版，
// 手寫字面量，不透過 m() 重建。
test("buildReport：英文版逐行格式（手寫字面量，數字不對稱，涵蓋 tpmPeakLine 等高風險多數字 key）", () => {
  const tpmSpoke: ResolvedSpoke = {
    ...SPOKE,
    providerConfig: { ...SPOKE.providerConfig, tpmLimit: 500_000 },
  };
  const estimates = [{ agent: SPOKE.agent, estimatedTokens: 321 }];
  const allowlistEstimates: AllowlistEstimate[] = [
    { agent: SPOKE.agent, estimatedTokens: 12_345, fileCount: 7, sequential: { asListed: 80_000, sorted: 20_000 } },
  ];
  const report = buildReport(
    "t1",
    [tpmSpoke],
    estimates,
    allowlistEstimates,
    CLI,
    "tmp/spoke/t1",
    { repoRoot: "/x", providersSource: BUNDLED, gitignoreStatus: "not_ignored", reviewTextChars: 100, strayHeadings: [] },
    "en",
  );
  assert.match(report, /providers\s+bundled \(formatVersion 1\)/);
  assert.match(
    report,
    /Initial prompt estimate 321 tokens \(system prompt \+ first message only; excludes the ticket and allowlist; this gate's cap is 200,000\)/,
  );
  assert.match(report, /Allowlist total estimate 12,345 tokens \(7 file\(s\)\)/);
  assert.match(report, /Sequential-read order amplification 80,000 tokens/);
  assert.match(report, /⚠ Sorting large files last could bring this down to 20,000 \(saves 75% here\)/);
  assert.match(report, /deepseek tpmLimit 500,000, statically estimated peak 321/);
  assert.match(report, /Concurrency 2/);
  assert.match(report, /⚠ Output directory tmp\/spoke\/t1 is not ignored by the git repo it lives in/);
});

// v0.2.0：乾跑報表印本次型號的單價。起因是 /publish-check 判斷清單第 4 項——skill 改成
// 「價目查 providers.json，不要查官網」之後，外部專案的 hub 其實找不到那個檔（隨套件出貨，
// 路徑帶版本號與相依雜湊）。這一行讓那個檔不必被找到。
const UNPRICED: ResolvedSpoke = {
  ...SPOKE,
  providerConfig: { ...SPOKE.providerConfig, pricing: undefined, pricingAsOf: undefined },
};

function reportFor(spoke: ResolvedSpoke, lang: "zh" | "en") {
  return buildReport("t1", [spoke], ESTIMATES, NO_ALLOWLIST, CLI, "tmp/spoke/t1",
    { repoRoot: "/r", providersSource: BUNDLED, gitignoreStatus: "ignored", reviewTextChars: 100, strayHeadings: [] }, lang);
}

test("buildReport：有價目時印出 input／output／cached 單價與查證日（中文）", () => {
  assert.match(reportFor(SPOKE, "zh"),
    /單價 每 M token：input \$0\.14／output \$0\.28／cached input \$0\.0028；價目查證日 2026-08-09/);
});

test("buildReport：有價目時印出 input／output／cached 單價與查證日（英文）", () => {
  assert.match(reportFor(SPOKE, "en"),
    /Price per M tokens: input \$0\.14 \/ output \$0\.28 \/ cached input \$0\.0028; priced as of 2026-08-09/);
});

test("buildReport：無 cachedInputPerM 時不印該欄，也不補 0", () => {
  const noCached: ResolvedSpoke = {
    ...SPOKE,
    providerConfig: {
      ...SPOKE.providerConfig,
      pricing: { "deepseek-v4-flash": { inputPerM: 0.14, outputPerM: 0.28 } },
    },
  };
  const report = reportFor(noCached, "zh");
  assert.match(report, /input \$0\.14／output \$0\.28；價目查證日/);
  assert.equal(/cached/.test(report), false);
});

test("buildReport：無 pricingSource.asOf 時不印查證日（寬鬆解析：壞掉的 metadata 不致命）", () => {
  const noAsOf: ResolvedSpoke = {
    ...SPOKE,
    providerConfig: { ...SPOKE.providerConfig, pricingAsOf: undefined },
  };
  const report = reportFor(noAsOf, "zh");
  assert.match(report, /input \$0\.14／output \$0\.28/);
  assert.equal(/價目查證日/.test(report), false);
});

// §4 的語意在報表上也要成立：「無法估算」不是「估算出來是零」。印 $0 會讓 hub 以為免費。
test("buildReport：缺該型號價目時明說無法估算，不印 $0", () => {
  const report = reportFor(UNPRICED, "zh");
  assert.match(report, /⚠ providers\.json 沒有 "deepseek-v4-flash" 的價目，本型號無法估算成本/);
  assert.equal(/\$0(?!\.\d*[1-9])/.test(report), false, "不得出現 $0 這種會被讀成免費的數字");
});
