// plan_dispatch_v1.4.md §11：派工報表（呼叫前）。模型錯了、effort 不如預期、介面走錯、
// 成本量級不對，在送出前就看得到。不使用 ✓／✗ 標記——TPM 是滑動窗，429 等待會動態改變
// 實際並行數，靜態估算無法精確預測。

import type { AllowlistEstimate, SpokeEstimate } from "./gate.js";
import type { ResolvedSpoke } from "./validate.js";
import type { GitignoreStatus } from "./gitignore-check.js";
import { stripFrontmatter } from "./ticket.js";
import { FIXED_CLOSING_LINE, FIXED_CLOSING_LINE_EN } from "./audit.js";
import { m } from "./messages.js";
import type { Lang } from "./types.js";

export type CliOptions = {
  out: string;
  concurrency: number;
  maxTokens: number;
  maxSpokeTokens: number;
  timeoutSec: number;
  retries: number;
  rateLimitRetries: number;
  maxRateWaitSec: number;
  maxToolCalls: number;
  charsPerToken: number; // §14：閘門一估算係數，providers.json 逐家覆寫
  maxSpokeReasoningTokens: number; // §14：累積推理 token 上限
  maxRoundReasoningTokens: number | null; // §14：單輪推理 token 上限，null = 不檢查
  repoRoot?: string; // v1.10 §9：白名單邊界與 .claude/agents 的根，未填則用 cwd
  providersPath?: string; // v1.10 §9：整檔取代出貨的 providers.json，未填則用出貨版本
  // plan_i18n_impl_tickets T3〈T1 驗收帶出的兩條〉：欄位由 lang 改名 langRaw——它是
  // --lang 的原始值，未經 parseLang 驗證，可能是 undefined（沒帶旗標）或 "ZH-TW"
  // （未正規化）。CLI 層訊息一律用 resolveLang() 的回傳值決定語言，不得讀這個欄位；
  // 誤讀會靜默走中文分支且型別不會紅（string | undefined 對 typecheck 不痛不癢），
  // 改名是這裡唯一買得起的機制，讓誤用在閱讀時就刺眼。與 DISPATCH_LANG 的組合判定見
  // cli-args.ts 的 resolveLang，未填代表旗標未帶。
  langRaw?: string;
  json: boolean; // v1.10 §25：stdout 只印結果 JSON，其餘輸出改走 stderr
  dryRun: boolean;
  yes: boolean;
};

// v1.10 §11：報表明列 providers 來源，與 §24.3「方案 D：隨工具出貨、不可覆寫」對應。
export type ProvidersSource = {
  kind: "bundled" | "explicit";
  path?: string;
  formatVersion: number;
};

export function effectiveCap(spoke: ResolvedSpoke, cli: CliOptions): number {
  return spoke.providerConfig.maxSpokeTokens ?? cli.maxSpokeTokens;
}

export function effectiveCharsPerToken(spoke: ResolvedSpoke, cli: CliOptions): number {
  return spoke.providerConfig.charsPerToken ?? cli.charsPerToken;
}

function formatProvidersSource(src: ProvidersSource, lang: Lang): string {
  if (src.kind === "bundled") return m(lang, "providersBundled", src.formatVersion);
  return m(lang, "providersExplicit", src.path ?? "", src.formatVersion);
}

// v1.10 §10：三態不得合併——「未忽略」是需要處理的狀態，「無法判定」不是，措辭須區分。
//
// hub 驗收（2026-08-06）：措辭原寫「未被目標專案的 .gitignore 涵蓋」，但 v1.11 §24.5
// 已訂輸出目錄屬呼叫端 cwd，checkGitignore 檢查的也是 cwd 所屬的 repo——cwd 與
// --repo-root 指的目標專案是兩回事（v1.11 §10 修的正是這個基準不一致）。「目標專案」
// 這個詞在 cwd ≠ repoRoot 時會指錯對象，故改為不預設兩者相同的措辭。
function formatGitignoreWarning(status: GitignoreStatus, outDir: string, lang: Lang): string | null {
  if (status === "ignored") return null;
  if (status === "not_ignored") {
    return m(lang, "gitignoreNotIgnored", outDir);
  }
  return m(lang, "gitignoreUnknown", outDir);
}

// plan_i18n_v1.2.md §6.3：呼叫前提示 lens 收尾句落在哪一個 FIXED_CLOSING_LINE*——只提示不擋
// （同既有 gitignore 警告），讓 lens 檔案本身的收尾句指示（如「回報最後一行固定為：...」）
// 在真正付費呼叫之前先被人看到有沒有漂移。agentBody 已在 resolveSpokes 剝過 frontmatter，
// 這裡再跑一次 stripFrontmatter 是冪等的（不再以 --- 開頭，regex 不命中），不需重讀檔。
function lensClosingLineStatus(agentBody: string): "zh" | "en" | "none" {
  const lines = stripFrontmatter(agentBody).split(/\r?\n/).map((l) => l.trim());
  const lastNonEmpty = [...lines].reverse().find((l) => l.length > 0) ?? "";
  if (lastNonEmpty.includes(FIXED_CLOSING_LINE)) return "zh";
  if (lastNonEmpty.includes(FIXED_CLOSING_LINE_EN)) return "en";
  return "none";
}

// 沒有收尾句的 lens（如 explore-haiku.md，不是 hole-finder 系列、不受這份收尾句約定拘束）
// 回傳 null、不印任何提示——只對「有收尾句、值得比對」的 lens 發聲，才不會對每一支
// 不相干的 lens 都噴一行「未偵測到」的常駐噪音。
function formatLensClosingLineNotice(spoke: ResolvedSpoke, lang: Lang): string | null {
  const status = lensClosingLineStatus(spoke.agentBody);
  if (status === "zh") return m(lang, "lensClosingLineZh", spoke.agent);
  if (status === "en") return m(lang, "lensClosingLineEn", spoke.agent);
  return null;
}

// v0.2.0：把本次型號的單價印進乾跑報表。起因是 /publish-check 判斷清單第 4 項
// （「指向的機制在外部專案存在嗎」）：skill 改成「價目查 providers.json，不要查官網」之後，
// 外部專案的 hub 其實找不到那個檔——它隨套件出貨，躺在 node_modules 或全域安裝目錄底下，
// 路徑帶版本號與相依雜湊，猜不到。找不到就會退回舊行為去查官網，等於那條規則只修了一半。
//
// **這一行讓那個檔不必被找到。** 順帶也解決 `--providers` 覆寫之後 hub 讀到錯的那一份。
// 缺價目時明講「無價目資料」而不是印 0——與 cost.ts 的 null 語意一致（§4：「無法估算」
// 與「估算出來是零」不是同一件事）。
function formatModelPricing(spoke: ResolvedSpoke, lang: Lang): string {
  const pricing = spoke.providerConfig.pricing?.[spoke.model];
  if (!pricing) return m(lang, "modelPricingMissing", spoke.model);
  const cached =
    pricing.cachedInputPerM !== undefined ? m(lang, "modelPricingCachedSuffix", pricing.cachedInputPerM) : "";
  const asOf = spoke.providerConfig.pricingAsOf
    ? m(lang, "modelPricingAsOfSuffix", spoke.providerConfig.pricingAsOf)
    : "";
  return m(lang, "modelPricing", pricing.inputPerM, pricing.outputPerM, cached, asOf);
}

export function buildReport(
  ticketId: string,
  spokes: ResolvedSpoke[],
  estimates: SpokeEstimate[],
  allowlistEstimates: AllowlistEstimate[],
  cli: CliOptions,
  outDir: string,
  meta: { repoRoot: string; providersSource: ProvidersSource; gitignoreStatus: GitignoreStatus },
  lang: Lang,
): string {
  const estByAgent = new Map(estimates.map((e) => [e.agent, e.estimatedTokens]));
  const lines: string[] = [m(lang, "aboutToDispatch", ticketId)];

  // v1.10 §11：repoRoot 明列於報表，與 store 同性質的可見性保證——白名單是整套隔離的
  // 唯一支點（§7），其邊界由「從哪個目錄下指令」決定，這件事在報表上必須看得見，否則
  // 使用者無從發現自己在錯的目錄下跑。
  lines.push(`  repoRoot   ${meta.repoRoot}`);
  lines.push(`  providers  ${formatProvidersSource(meta.providersSource, lang)}`);

  for (const spoke of spokes) {
    const est = estByAgent.get(spoke.agent) ?? 0;
    const cap = effectiveCap(spoke, cli);
    lines.push(
      `  ${spoke.agent.padEnd(20)} → ${spoke.provider.padEnd(8)} / ${spoke.model.padEnd(20)} ` +
        `[${spoke.providerConfig.api}] effort=${spoke.effort ?? "—"} lang=${spoke.lang} ` +
        `store=${spoke.providerConfig.store === false ? "false" : "n/a"} ` +
        `est. ${est.toLocaleString()}  cap ${cap.toLocaleString()}`,
    );
    lines.push(`  ${formatModelPricing(spoke, lang)}`);
    const closingLineNotice = formatLensClosingLineNotice(spoke, lang);
    if (closingLineNotice) lines.push(`  ${closingLineNotice}`);
  }

  const totalEst = estimates.reduce((s, e) => s + e.estimatedTokens, 0);
  const worstTotal = spokes.reduce((s, spoke) => s + effectiveCap(spoke, cli), 0);
  // plan_fixes_v1.0.md §3：舊標籤「合計初始估算」被外部 hub 誤讀成整輪派工的成本估算——
  // 這個數字只涵蓋 system prompt ＋ buildFirstUserText() 產出的第一則訊息，不含工單與
  // 允許清單本身（那些是 spoke 自己用 tool call 讀進去的）。實測差距 27 倍（2,593 vs
  // 71,482）。標籤明講範圍，並緊接印出允許清單總量，讓兩個數字一起出現、不必自己去找。
  lines.push(m(lang, "initialPromptEstimate", totalEst.toLocaleString(), cli.maxTokens.toLocaleString()));

  // §14：獨立於閘門一之外，只呈現不設閘門——閘門一不含允許清單與工單內容（issue_log_v2.0.md
  // 2026-08-07），此數字才是「若整個允許清單都被讀完」的量級參考，門檻待樣本累積後再定。
  const totalAllowlistTokens = allowlistEstimates.reduce((s, e) => s + e.estimatedTokens, 0);
  const totalAllowlistFiles = allowlistEstimates.reduce((s, e) => s + e.fileCount, 0);
  lines.push(m(lang, "allowlistTotalEstimate", totalAllowlistTokens.toLocaleString(), totalAllowlistFiles));
  // plan_dispatch_v2.4.md §14：口徑說明——避免此數字被誤讀為預期消耗。三件事：
  // (1) 字元數的上限估計，不是預期消耗；(2) 不去重，同一檔出現在多支清單會重複計入
  // （正確行為：兩支各讀一次就是兩份成本）；(3) 實測程式碼素材約 3.5 字元／token，
  // 故實際消耗通常遠低於此數（charsPerToken 假設 1.0，係數本身刻意不動，見 §14）。
  lines.push(m(lang, "allowlistEstimateCaveat"));

  // issue_log_v2.1.md（第 8、9 次）：多數模型一輪只叫一個檔，每輪重送全部歷史，故清單靠前
  // 的檔會被重複計費多次。這一行是「順序造成的放大量」，也是唯一 hub 改得動的成本槓桿——
  // 只印排序能省的部分，不印預估總量：總量還受「批次讀 vs 逐個讀」影響（模型決定，我們
  // 控制不了），印出來會被當成預期值。省下的百分比則不受 charsPerToken 偏差影響（分子分母
  // 抵銷），是這裡唯一可信的絕對數字。
  //
  // real-run-same-lens §九之6 要求這一行標明「此為逐個讀假設下的上限」，訊息文字已補。
  // real-run-i18n-lang（2026-08-12）另加一條：讀檔形態**不只隨型號變，也隨 prompt 語言變**
  // ——同型號同 effort，只把語言從中文換成英文，luna 的 feasibility 就從 9 輪（逐個）
  // 變 4 輪（批次）。所以「這個廠牌會不會批次」在乾跑階段更不可能預先判定。
  const seqAsListed = allowlistEstimates.reduce((s, e) => s + e.sequential.asListed, 0);
  const seqSorted = allowlistEstimates.reduce((s, e) => s + e.sequential.sorted, 0);
  if (seqAsListed > 0) {
    const savedPct = Math.round(((seqAsListed - seqSorted) / seqAsListed) * 100);
    lines.push(m(lang, "sequentialReadAmplification", seqAsListed.toLocaleString()));
    if (savedPct >= 5) {
      lines.push(m(lang, "sequentialReadCanReduce", seqSorted.toLocaleString(), savedPct));
    } else {
      lines.push(m(lang, "sequentialReadNearOptimal", savedPct));
    }
    lines.push(m(lang, "sequentialReadCostNote"));
  }

  lines.push(m(lang, "worstCaseTotal", worstTotal.toLocaleString()));
  lines.push(m(lang, "concurrencyLine", cli.concurrency));

  const byProvider = new Map<string, { tpmLimit: number | null; peak: number }>();
  for (const spoke of spokes) {
    const est = estByAgent.get(spoke.agent) ?? 0;
    const entry = byProvider.get(spoke.provider) ?? { tpmLimit: spoke.providerConfig.tpmLimit, peak: 0 };
    entry.peak += est;
    byProvider.set(spoke.provider, entry);
  }
  for (const [provider, { tpmLimit, peak }] of byProvider) {
    if (tpmLimit === null) continue;
    lines.push(m(lang, "tpmPeakLine", provider, tpmLimit.toLocaleString(), peak.toLocaleString()));
    lines.push(m(lang, "tpmPeakCaveat"));
  }

  const allowedCount = spokes.reduce((s, spoke) => s + spoke.allowedReadsResolved.length, 0);
  lines.push(m(lang, "allowedReadsSummary", allowedCount, outDir));

  const gitignoreWarning = formatGitignoreWarning(meta.gitignoreStatus, outDir, lang);
  if (gitignoreWarning) lines.push(gitignoreWarning);

  return lines.join("\n");
}
