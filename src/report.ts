// plan_dispatch_v1.4.md §11：派工報表（呼叫前）。模型錯了、effort 不如預期、介面走錯、
// 成本量級不對，在送出前就看得到。不使用 ✓／✗ 標記——TPM 是滑動窗，429 等待會動態改變
// 實際並行數，靜態估算無法精確預測。

import type { AllowlistEstimate, SpokeEstimate } from "./gate.js";
import type { ResolvedSpoke } from "./validate.js";
import type { GitignoreStatus } from "./gitignore-check.js";

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

function formatProvidersSource(src: ProvidersSource): string {
  if (src.kind === "bundled") return `出貨（formatVersion ${src.formatVersion}）`;
  return `外部檔 ${src.path}（formatVersion ${src.formatVersion}）`;
}

// v1.10 §10：三態不得合併——「未忽略」是需要處理的狀態，「無法判定」不是，措辭須區分。
//
// hub 驗收（2026-08-06）：措辭原寫「未被目標專案的 .gitignore 涵蓋」，但 v1.11 §24.5
// 已訂輸出目錄屬呼叫端 cwd，checkGitignore 檢查的也是 cwd 所屬的 repo——cwd 與
// --repo-root 指的目標專案是兩回事（v1.11 §10 修的正是這個基準不一致）。「目標專案」
// 這個詞在 cwd ≠ repoRoot 時會指錯對象，故改為不預設兩者相同的措辭。
function formatGitignoreWarning(status: GitignoreStatus, outDir: string): string | null {
  if (status === "ignored") return null;
  if (status === "not_ignored") {
    return `  ⚠ 輸出目錄 ${outDir} 未被輸出目錄所在的 git repo 忽略`;
  }
  return `  ℹ 無法判定輸出目錄 ${outDir} 是否被 .gitignore 涵蓋（非 git repo 或 git 不可用）`;
}

export function buildReport(
  ticketId: string,
  spokes: ResolvedSpoke[],
  estimates: SpokeEstimate[],
  allowlistEstimates: AllowlistEstimate[],
  cli: CliOptions,
  outDir: string,
  meta: { repoRoot: string; providersSource: ProvidersSource; gitignoreStatus: GitignoreStatus },
): string {
  const estByAgent = new Map(estimates.map((e) => [e.agent, e.estimatedTokens]));
  const lines: string[] = [`即將派工 ${ticketId}：`];

  // v1.10 §11：repoRoot 明列於報表，與 store 同性質的可見性保證——白名單是整套隔離的
  // 唯一支點（§7），其邊界由「從哪個目錄下指令」決定，這件事在報表上必須看得見，否則
  // 使用者無從發現自己在錯的目錄下跑。
  lines.push(`  repoRoot   ${meta.repoRoot}`);
  lines.push(`  providers  ${formatProvidersSource(meta.providersSource)}`);

  for (const spoke of spokes) {
    const est = estByAgent.get(spoke.agent) ?? 0;
    const cap = effectiveCap(spoke, cli);
    lines.push(
      `  ${spoke.agent.padEnd(20)} → ${spoke.provider.padEnd(8)} / ${spoke.model.padEnd(20)} ` +
        `[${spoke.providerConfig.api}] effort=${spoke.effort ?? "—"} lang=${spoke.lang} ` +
        `store=${spoke.providerConfig.store === false ? "false" : "n/a"} ` +
        `est. ${est.toLocaleString()}  cap ${cap.toLocaleString()}`,
    );
  }

  const totalEst = estimates.reduce((s, e) => s + e.estimatedTokens, 0);
  const worstTotal = spokes.reduce((s, spoke) => s + effectiveCap(spoke, cli), 0);
  // plan_fixes_v1.0.md §3：舊標籤「合計初始估算」被外部 hub 誤讀成整輪派工的成本估算——
  // 這個數字只涵蓋 system prompt ＋ buildFirstUserText() 產出的第一則訊息，不含工單與
  // 允許清單本身（那些是 spoke 自己用 tool call 讀進去的）。實測差距 27 倍（2,593 vs
  // 71,482）。標籤明講範圍，並緊接印出允許清單總量，讓兩個數字一起出現、不必自己去找。
  lines.push(
    `  初始 prompt 估算 ${totalEst.toLocaleString()} tokens（僅 system prompt＋首則訊息，不含工單與允許清單；本閘門的估算上限 ${cli.maxTokens.toLocaleString()}）`,
  );

  // §14：獨立於閘門一之外，只呈現不設閘門——閘門一不含允許清單與工單內容（issue_log_v2.0.md
  // 2026-08-07），此數字才是「若整個允許清單都被讀完」的量級參考，門檻待樣本累積後再定。
  const totalAllowlistTokens = allowlistEstimates.reduce((s, e) => s + e.estimatedTokens, 0);
  const totalAllowlistFiles = allowlistEstimates.reduce((s, e) => s + e.fileCount, 0);
  lines.push(`  允許清單總量估算 ${totalAllowlistTokens.toLocaleString()} tokens（${totalAllowlistFiles} 檔）`);
  // plan_dispatch_v2.4.md §14：口徑說明——避免此數字被誤讀為預期消耗。三件事：
  // (1) 字元數的上限估計，不是預期消耗；(2) 不去重，同一檔出現在多支清單會重複計入
  // （正確行為：兩支各讀一次就是兩份成本）；(3) 實測程式碼素材約 3.5 字元／token，
  // 故實際消耗通常遠低於此數（charsPerToken 假設 1.0，係數本身刻意不動，見 §14）。
  lines.push(`    └ 上限估計，不去重；實測程式碼素材約 3.5 字元／token，實際消耗通常遠低於此數`);

  // issue_log_v2.1.md（第 8、9 次）：多數模型一輪只叫一個檔，每輪重送全部歷史，故清單靠前
  // 的檔會被重複計費多次。這一行是「順序造成的放大量」，也是唯一 hub 改得動的成本槓桿——
  // 只印排序能省的部分，不印預估總量：總量還受「批次讀 vs 逐個讀」影響（模型決定，我們
  // 控制不了），印出來會被當成預期值。省下的百分比則不受 charsPerToken 偏差影響（分子分母
  // 抵銷），是這裡唯一可信的絕對數字。
  const seqAsListed = allowlistEstimates.reduce((s, e) => s + e.sequential.asListed, 0);
  const seqSorted = allowlistEstimates.reduce((s, e) => s + e.sequential.sorted, 0);
  if (seqAsListed > 0) {
    const savedPct = Math.round(((seqAsListed - seqSorted) / seqAsListed) * 100);
    lines.push(`  逐個讀的順序放大量 ${seqAsListed.toLocaleString()} tokens（清單內容被重送的總量）`);
    if (savedPct >= 5) {
      lines.push(`    └ ⚠ 大檔排清單最後可降至 ${seqSorted.toLocaleString()}（本項省 ${savedPct}%）`);
    } else {
      lines.push(`    └ 目前順序已接近最佳（重排最多再省 ${savedPct}%）`);
    }
    lines.push(`      本項不含初始 prompt 與工單（不受排序影響），故總成本的節省比例低於此數`);
  }

  lines.push(`  最壞總消耗 ≈ ${worstTotal.toLocaleString()} tokens（各 spoke 之 cap 加總）`);
  lines.push(`  並行度 ${cli.concurrency}`);

  const byProvider = new Map<string, { tpmLimit: number | null; peak: number }>();
  for (const spoke of spokes) {
    const est = estByAgent.get(spoke.agent) ?? 0;
    const entry = byProvider.get(spoke.provider) ?? { tpmLimit: spoke.providerConfig.tpmLimit, peak: 0 };
    entry.peak += est;
    byProvider.set(spoke.provider, entry);
  }
  for (const [provider, { tpmLimit, peak }] of byProvider) {
    if (tpmLimit === null) continue;
    lines.push(`  ${provider} tpmLimit ${tpmLimit.toLocaleString()}，靜態估算峰值 ${peak.toLocaleString()}`);
    lines.push(`    └ 僅為靜態指標，不預測執行中的 TPM 曲線（429 等待會改變實際並行數）`);
  }

  const allowedCount = spokes.reduce((s, spoke) => s + spoke.allowedReadsResolved.length, 0);
  lines.push(`  允許讀取 ${allowedCount} 個檔案，輸出至 ${outDir}/`);

  const gitignoreWarning = formatGitignoreWarning(meta.gitignoreStatus, outDir);
  if (gitignoreWarning) lines.push(gitignoreWarning);

  return lines.join("\n");
}
