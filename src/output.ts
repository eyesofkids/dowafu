// D1：Spoke 結果只寫進 SQLite 的 results 欄位；所有落庫內容在寫入前經 maskDeep 遮蔽。

import type { Lang, SpokeRunResult } from "./types.js";
import type { AuditResult, TemplatePlaceholderHit } from "./audit.js";
import type { ToolCallAudit } from "./tool-call-audit.js";
import { maskDeep, maskString } from "./mask.js";
import { m } from "./messages.js";
import type { DatabaseSync } from "node:sqlite";

function formatStoreCell(store: SpokeRunResult["store"]): string {
  return store === "false" ? "false" : store;
}

// §14：truncated:budget 需顯示觸發來源；reasoning_round 是「模型在某一輪卡住」的異常訊號，
// 與正常的總量／累積推理超支後續動作不同（前者查 prompt 或換 effort，後者調門檻），
// 須顯眼區分，不能跟其他 truncated:budget 混在一起看起來像同一種情況。
function formatStatusCell(r: SpokeRunResult, lang: Lang): string {
  if (r.status !== "truncated:budget" || !r.budgetTrigger) return r.status;
  const label = m(lang, "budgetTriggerLabel", r.budgetTrigger);
  const flag = r.budgetTrigger === "reasoning_round" ? m(lang, "anomalySpikeFlag") : "";
  return `${r.status}（${flag}${label}）`;
}

// 工單 status-stdin §A-2：只在 provider 自己明確回報了非正常結束（finishReasonRaw 非
// null，且 normalizeFinishReason 沒把它正規化成 "stop"）時才印；正常結束不多印一欄。
// finishReason／finishReasonRaw 在這個條件下必然相等（usage.ts 的 STOP_VALUES 之外一律
// 原樣保留），印 finishReason 即可，不必額外帶 raw。
function formatFinishReasonCell(r: SpokeRunResult, lang: Lang): string | null {
  if (r.finishReasonRaw === null || r.finishReason === "stop") return null;
  return m(lang, "finishReasonWarningCell", r.finishReason ?? "unknown");
}

// 工單 X1 v1.1 §二：模板佔位符若被留在回報裡，列出是哪幾個、各幾次；沒有命中維持既有
// 風格印「無」。
function formatPlaceholdersCell(hits: TemplatePlaceholderHit[], lang: Lang): string {
  if (hits.length === 0) return m(lang, "noneLabel");
  return hits.map((h) => m(lang, "templatePlaceholderEntry", h.placeholder, h.count)).join(", ");
}

export function buildSummaryMarkdown(
  ticketId: string,
  results: SpokeRunResult[],
  audits: Map<string, AuditResult>,
  toolCallAudits: Map<string, ToolCallAudit>,
  lang: Lang,
): string {
  const rows = results.map((r) => {
    const a = audits.get(r.agent);
    const t = toolCallAudits.get(r.agent);
    const cells: string[] = [];
    // plan_dispatch_v2.6.md §26 規格四：hub 會讀的地方才有用（「順序放大量」印進乾跑報表
    // 後 hub 才真的重排清單，第 10 次派工，省 52%），放最前面顯眼標示。
    if (r.unknownUsageKeys.length > 0) {
      cells.push(m(lang, "unknownUsageKeysWarning", r.provider, r.unknownUsageKeys.join(", ")));
    }
    // §15（一）：沒看程式碼就作答的簽名，放最前面顯眼標示——見 tool-call-audit.ts。
    if (t?.zeroSourceRead) {
      cells.push(m(lang, "zeroSourceReadWarning", t.allowedReadsCount));
    }
    const finishReasonCell = formatFinishReasonCell(r, lang);
    if (finishReasonCell !== null) {
      cells.push(finishReasonCell);
    }
    if (t) {
      cells.push(m(lang, "toolCallStats", t.total, t.allowed, t.rejected));
    }
    if (a) {
      cells.push(
        m(lang, "closingLineCell", a.finalLinePass ? "pass" : "fail"),
        // v1.9 §15：null（數不出來）與 0（明確為零）須可區分，不得混印
        m(
          lang,
          "observationCountCell",
          a.observationCount !== null ? String(a.observationCount) : m(lang, "cannotCountObservations"),
        ),
        m(lang, "cannotVerifySectionCell", a.cannotVerifySectionPresent ? "pass" : "fail"),
        m(lang, "templatePlaceholdersCell", formatPlaceholdersCell(a.templatePlaceholdersFound, lang)),
      );
    }
    const auditCell = cells.length > 0 ? cells.join(" / ") : m(lang, "auditUnavailable");
    // plan_fixes_v1.0.md §4：無價目資料須與「估出來是 $0」區分，不能印成空白或 0——
    // 兩者對讀者的意義完全不同（沒資料 vs 免費）。
    const costCell = r.costUsd === null ? m(lang, "noPricingData") : `$${r.costUsd.toFixed(4)}`;
    return `| ${r.agent} | ${r.provider} | ${r.api} | ${r.modelRequested} | ${r.modelReturned ?? "—"} | ${r.effort ?? "—"} | ${formatStoreCell(r.store)} | ${formatStatusCell(r, lang)} | ${r.latencyMs}ms | ${r.usage.totalTokens} | ${costCell} | ${auditCell} |`;
  });

  return `${m(lang, "summaryHeader", ticketId)}
${rows.join("\n")}
`;
}

// D1 DB persistence.  `results` deliberately has no opaque blob column: the three
// existing artifact families map to output/request/response and remain inspectable.
export function persistSpokeResultDb(db: DatabaseSync, ticket: string, result: SpokeRunResult): void {
  const output = result.status === "failed" ? null : maskString(result.finalText ?? "");
  const request = JSON.stringify(maskDeep({ requests: result.rawRequests, errors: result.rawErrors }));
  const response = JSON.stringify(maskDeep({ responses: result.rawResponses, result }));
  try {
    db.prepare(
      `INSERT INTO results (job_id, agent, output, request, response, tokens_in, tokens_out, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(ticket, result.agent, output, request, response, result.usage.inputTokens, result.usage.outputTokens, result.costUsd);
  } catch (err) {
    // cli.ts intentionally persists the exact same in-memory result twice: immediately
    // after a spoke, then once more in its post-settlement retry loop.  Keep that
    // idempotent case, but let every materially different duplicate surface as SQLite's
    // constraint error instead of silently replacing paid output.
    const existing = db.prepare(
      `SELECT output, request, response, tokens_in, tokens_out, cost_usd
       FROM results WHERE job_id = ? AND agent = ?`,
    ).get(ticket, result.agent) as {
      output: string | null;
      request: string | null;
      response: string | null;
      tokens_in: number | null;
      tokens_out: number | null;
      cost_usd: number | null;
    } | undefined;
    if (
      existing
      && existing.output === output
      && existing.request === request
      && existing.response === response
      && existing.tokens_in === result.usage.inputTokens
      && existing.tokens_out === result.usage.outputTokens
      && existing.cost_usd === result.costUsd
    ) return;
    throw err;
  }
}

export function writeSummaryDb(
  db: DatabaseSync,
  ticket: string,
  results: SpokeRunResult[],
  audits: Map<string, AuditResult>,
  toolCallAudits: Map<string, ToolCallAudit>,
  lang: Lang,
): void {
  const summary = buildSummaryMarkdown(ticket, results, audits, toolCallAudits, lang);
  db.prepare(
    `INSERT INTO results (job_id, agent, output, request, response, tokens_in, tokens_out, cost_usd)
     VALUES (?, '__summary__', ?, NULL, NULL, NULL, NULL, NULL)`,
  ).run(ticket, maskString(summary));
}

// 票 skill-refresh：把「讀回一次派工的結果」抽成 CLI 與 MCP 共用的唯一實作。
// D1 之後產物只在 DB，而在此之前**只有 MCP 的 dispatch_result 讀得回來**——走 CLI 直接
// 派工的人沒有對應指令，實測中的 Claude Code 因此自己去開 sqlite3（v0_5_0/_archived/log.md §八，當時記成
// 「client 又 shell out 了」的行為觀察，沒認出那是缺一個指令）。
//
// 兩個呼叫端共用同一支，是因為這批已經撞過三次「兩個呼叫端只改了一個」（票 B 的候選清單、
// 票 C 的 DOWAFU_HTTP_PORT、cost-cap 的 report/ticket-store）。
//
// `job_id` 欄存的是 resultId：CLI 直接派工時等於 ticket 名稱，走 daemon 佇列時是 job 的
// UUID。故先照原樣查一次，查不到再把它當成 ticket 名稱去找最近一筆完成的 job——兩條派工
// 路徑的使用者都能用同一個指令拿回結果。
// 工單 status-stdin §A-1：output IS NULL 是既有的失敗訊號（見 persistSpokeResultDb——
// 只有 status === "failed" 才寫 NULL，見上方 output 變數的三元運算）。先前這裡直接印
// `${agent}:\n`，付了錢卻拿到空段落的東西，跟「這支什麼都沒說」分不出來。lang 預設 en：
// 目前兩個呼叫端（cli.ts 的 `result` 子指令、mcp/protocol.ts 的 dispatch_result）都不在
// 本票的擁有清單內，改不了它們的呼叫點；預設值讓既有呼叫維持可編譯、行為只在「失敗且無
// 產出」這個先前本來就講不清楚的邊界上變化，成功的輸出逐字不受影響（見下方 map）。
export function readResults(db: DatabaseSync, ticketOrJobId: string, lang: Lang = "en"): string[] {
  const select = db.prepare("SELECT agent, output FROM results WHERE job_id = ? ORDER BY agent");
  let rows = select.all(ticketOrJobId) as Array<{ agent: string; output: string | null }>;
  if (rows.length === 0) {
    const latest = db
      // 驗收熱修補（票 skill-docs）：先前只找 `completed`，於是**失敗的佇列 job 用 ticket-id
      // 查不到**——而那正是最想看結果的時候（實測回「No results found」）。
      // failed 與 interrupted 一樣有已付費的 results 可讀：interrupted 是「跑到一半行程死了」，
      // 先完成的那幾支已經花過錢也已經落檔，把它們擋在外面與「落檔失敗不得銷毀已付費結果」
      // （D1-hot3）那條的立場相反。running 不列入：那是還在跑，回半截會被讀成最終答案。
      .prepare("SELECT id FROM jobs WHERE ticket = ? AND status IN ('completed', 'failed', 'interrupted') ORDER BY finished_at DESC LIMIT 1")
      .get(ticketOrJobId) as { id: string } | undefined;
    if (latest) rows = select.all(latest.id) as Array<{ agent: string; output: string | null }>;
  }
  return rows.map((row) => `${row.agent}:\n${row.output ?? m(lang, "noFullReportAvailable", "failed")}`);
}

// 工單 status-stdin §A-3：dispatch_status 對 completed／failed 的 job 要能講出成敗分佈
// ——「三支死一支」先前完全看不出來。沿用 §A-1 同一個 NULL 訊號（agent != '__summary__'：
// 稽核表本身的那一列不是 spoke，不計入分佈），不重算、不新增欄位。與 readResults 不同，
// 這裡的呼叫端（protocol.ts 的 dispatch_status）已經用 resolveJob 解出確切的 job.id，
// 不需要 readResults 那套「查無結果就回頭找 ticket 名稱」的雙路查詢。
export function readResultOutcomes(db: DatabaseSync, jobId: string): Array<{ agent: string; failed: boolean }> {
  const rows = db
    .prepare("SELECT agent, output FROM results WHERE job_id = ? AND agent != '__summary__' ORDER BY agent")
    .all(jobId) as Array<{ agent: string; output: string | null }>;
  return rows.map((row) => ({ agent: row.agent, failed: row.output === null }));
}
