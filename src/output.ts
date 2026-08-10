// plan_dispatch_v1.4.md §12/§16：落檔與 run.jsonl。寫入序列化——前一次 appendFile 未
// resolve 前不發下一次；呼叫平行，寫入序列。所有落檔內容在寫入前經 maskDeep 遮蔽（§12）。

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SpokeRunResult } from "./types.js";
import type { AuditResult, OutsideAllowlistCitation } from "./audit.js";
import type { ToolCallAudit } from "./tool-call-audit.js";
import { maskDeep, maskString } from "./mask.js";

export class RunLogWriter {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  // plan_dispatch_v2.4.md §12（一）：ts 語意為「append 被呼叫的當下」，即事件發生時刻，
  // 故在此（方法本體）取時間，不得延後到 queue 的 then callback 內——落盤時間會被檔案
  // 系統阻塞與 queue 排隊污染，失去診斷「哪一輪慢」的價值。ts 於 maskDeep 之後加入，
  // 避免遮蔽邏輯誤傷時間字串。
  append(event: Record<string, unknown>): void {
    const ts = new Date().toISOString();
    const masked = maskDeep(event) as Record<string, unknown>;
    const line = JSON.stringify({ ...masked, ts }) + "\n";
    // §12（二）：單次 appendFile 失敗只影響該行，不得毒化 queue——否則其後每一次
    // append 都不會執行，且 flush() 也會 rejected，等於一次瞬時寫入失敗讓該次派工
    // 其餘所有事件全部遺失。失敗以 stderr 留痕，不靜默吞掉。
    this.queue = this.queue.then(() => appendFile(this.filePath, line, "utf8")).catch((err) => {
      console.error(`run.jsonl 寫入失敗：${maskString(String(err))}`);
    });
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}

export async function ensureOutDir(outDir: string): Promise<void> {
  await mkdir(path.join(outDir, "raw"), { recursive: true });
  // §13：「同一工單重跑會覆蓋同名輸出目錄——刻意行為」。其餘產物（summary.md、
  // <agent>.md、raw/*.json）走 writeFile 自然覆蓋，唯獨 run.jsonl 走 appendFile
  // ——§12 的 append 是為**單次執行內**的中斷安全，不是跨次累積。不在此清空的話，
  // 重跑會把上一次的事件留著，而 toolCalls[] 正是偵測「零讀取」的唯一依據
  // （issue_log_v2.0.md 2026-08-07：hub 驗收時據此數錯 9／22 vs 實際 7／20）。
  await writeFile(path.join(outDir, "run.jsonl"), "", "utf8");
}

// §13：raw 一律無條件覆寫。v2.4 實作期間曾加過「空 raw 不覆蓋磁碟上的非空內容」守衛
// （由 v2.4 §20 的一條測試要求逼出來），驗收時撤除：它破壞了 §13「同一工單重跑會覆蓋
// 同名輸出目錄」——重跑時該 spoke 若零 raw，上一次的內容會留著冒充本次證據，與
// 21bbd83 修掉的 run.jsonl 污染同型，而 raw/ 是「當時究竟送了什麼出去」的唯一證據。
// 「防禦性空 result 覆寫已付費內容」那條路徑的保證，由 persistSpokeResult 的
// 「例外不外傳」單獨承擔——例外不外傳之後，results[i] 永遠是 runSpoke 的真實回傳值。
export async function writeRawFiles(outDir: string, agent: string, result: SpokeRunResult): Promise<void> {
  await writeFile(
    path.join(outDir, "raw", `${agent}.request.json`),
    JSON.stringify(maskDeep(result.rawRequests), null, 2),
    "utf8",
  );
  await writeFile(
    path.join(outDir, "raw", `${agent}.response.json`),
    JSON.stringify(maskDeep(result.rawResponses), null, 2),
    "utf8",
  );
  // plan_fixes_v1.0.md §6：先前失敗時 request/response 兩份都是 []（兩者只記成功輪次），
  // 中斷或失敗時完全沒有線索。獨立於上面兩份之外——不動既有「僅成功輪次」的語意，
  // 逐次錯誤（含重試中途、非終局那次）另開一份，空陣列＝未撞過任何錯誤。
  await writeFile(
    path.join(outDir, "raw", `${agent}.errors.json`),
    JSON.stringify(maskDeep(result.rawErrors), null, 2),
    "utf8",
  );
}

// §13：「原文產出」欄——failed 無產出；其餘（含 truncated:*）皆落檔，即使不完整，
// 因為那是已經付過錢的內容。
export async function writeSpokeText(outDir: string, agent: string, result: SpokeRunResult): Promise<void> {
  if (result.status === "failed") return;
  const content = result.finalText ?? `(無法取得完整回報，執行狀態：${result.status})`;
  await writeFile(path.join(outDir, `${agent}.md`), content, "utf8");
}

// plan_dispatch_v2.4.md §13（一）：每支 spoke 完成即落檔的落地點。落檔例外不得外傳——
// 落檔失敗不得使呼叫端的 promise rejected、不得改變該 spoke 的 status（落檔是產物持久化，
// 不是執行結果），但必須留下痕跡：寫入 result.errors[] 並經 onError 回報。
// writeSpokeText、writeRawFiles 各自包住例外，其一失敗不影響另一個執行。
export async function persistSpokeResult(
  outDir: string,
  result: SpokeRunResult,
  onError: (message: string) => void,
): Promise<void> {
  try {
    await writeSpokeText(outDir, result.agent, result);
  } catch (err) {
    const msg = `落檔失敗（${result.agent}.md）：${maskString(String(err))}`;
    result.errors.push(msg);
    onError(msg);
  }
  try {
    await writeRawFiles(outDir, result.agent, result);
  } catch (err) {
    const msg = `落檔失敗（${result.agent} raw/）：${maskString(String(err))}`;
    result.errors.push(msg);
    onError(msg);
  }
}

function formatStoreCell(store: SpokeRunResult["store"]): string {
  return store === "false" ? "false" : store;
}

const BUDGET_TRIGGER_LABEL: Record<NonNullable<SpokeRunResult["budgetTrigger"]>, string> = {
  total: "總量",
  reasoning: "推理累積",
  reasoning_round: "推理單輪尖峰",
};

// §14：truncated:budget 需顯示觸發來源；reasoning_round 是「模型在某一輪卡住」的異常訊號，
// 與正常的總量／累積推理超支後續動作不同（前者查 prompt 或換 effort，後者調門檻），
// 須顯眼區分，不能跟其他 truncated:budget 混在一起看起來像同一種情況。
function formatStatusCell(r: SpokeRunResult): string {
  if (r.status !== "truncated:budget" || !r.budgetTrigger) return r.status;
  const label = BUDGET_TRIGGER_LABEL[r.budgetTrigger];
  const flag = r.budgetTrigger === "reasoning_round" ? "⚠ 異常尖峰・" : "";
  return `${r.status}（${flag}${label}）`;
}

// plan_dispatch_v2.0.md §15（二）：清單外引用附出現章節與疑似縮寫來源，讓讀者不必自己去猜
// （issue_log_v2.0.md 2026-08-07：曾有 hub 因為裸字串誤判成稽核器的 bug，推錯了方向）。
function formatOutsideAllowlistCell(detail: OutsideAllowlistCitation[]): string {
  if (detail.length === 0) return "無";
  return detail
    .map((d) => {
      const sectionPart = d.section ? `「${d.section}」節` : "章節外";
      const suffixPart = d.suffixOf ? `；疑似 ${d.suffixOf} 的縮寫` : "";
      return `${d.path}（${sectionPart}${suffixPart}）`;
    })
    .join(",");
}

export function buildSummaryMarkdown(
  ticketId: string,
  results: SpokeRunResult[],
  audits: Map<string, AuditResult>,
  toolCallAudits: Map<string, ToolCallAudit>,
): string {
  const rows = results.map((r) => {
    const a = audits.get(r.agent);
    const t = toolCallAudits.get(r.agent);
    const cells: string[] = [];
    // plan_dispatch_v2.6.md §26 規格四：hub 會讀的地方才有用（「順序放大量」印進乾跑報表
    // 後 hub 才真的重排清單，第 10 次派工，省 52%），放最前面顯眼標示。
    if (r.unknownUsageKeys.length > 0) {
      cells.push(`⚠ 未知 usage 欄位：${r.provider} ${r.unknownUsageKeys.join(", ")}`);
    }
    // §15（一）：沒看程式碼就作答的簽名，放最前面顯眼標示——見 tool-call-audit.ts。
    if (t?.zeroSourceRead) {
      cells.push(`⚠ 零原始碼讀取（允許 ${t.allowedReadsCount} 檔）`);
    }
    if (t) {
      cells.push(`工具呼叫:${t.total}（允許 ${t.allowed}／拒絕 ${t.rejected}）`);
    }
    if (a) {
      cells.push(
        `收尾句:${a.finalLinePass ? "pass" : "fail"}`,
        `觀察:${a.observationCount ?? "無法計數"}`, // v1.9 §15：null（數不出來）與 0（明確為零）須可區分，不得混印
        `清單外引用:${formatOutsideAllowlistCell(a.citedPathsOutsideAllowlistDetail)}`,
        `無法驗證欄:${a.cannotVerifySectionPresent ? "pass" : "fail"}`,
        `疑似禁止內容:${a.suspectPhrases.length > 0 ? a.suspectPhrases.join(",") : "無"}`,
      );
    }
    const auditCell = cells.length > 0 ? cells.join(" / ") : "(無法稽核)";
    // plan_fixes_v1.0.md §4：無價目資料須與「估出來是 $0」區分，不能印成空白或 0——
    // 兩者對讀者的意義完全不同（沒資料 vs 免費）。
    const costCell = r.costUsd === null ? "無價目資料" : `$${r.costUsd.toFixed(4)}`;
    return `| ${r.agent} | ${r.provider} | ${r.api} | ${r.modelRequested} | ${r.modelReturned ?? "—"} | ${r.effort ?? "—"} | ${formatStoreCell(r.store)} | ${formatStatusCell(r)} | ${r.latencyMs}ms | ${r.usage.totalTokens} | ${costCell} | ${auditCell} |`;
  });

  return `# dispatch summary — ${ticketId}

| agent | provider | api | model(請求) | model(回傳) | effort | store | status | 耗時 | token | 估算成本 | 稽核 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}
`;
}

export async function writeSummary(
  outDir: string,
  ticketId: string,
  results: SpokeRunResult[],
  audits: Map<string, AuditResult>,
  toolCallAudits: Map<string, ToolCallAudit>,
): Promise<void> {
  const md = buildSummaryMarkdown(ticketId, results, audits, toolCallAudits);
  await writeFile(path.join(outDir, "summary.md"), md, "utf8");
}
