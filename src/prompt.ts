// plan_dispatch_v1.4.md §8：system prompt 與第一個 user turn 的組裝規格。
// 三段依序串接：agent body（frontmatter 已由 validate.ts 剝除）＋ 回報模板（dispatch 側維護，
// 不寫進 agent 檔）＋ 工具說明。

// plan_dispatch_v2.0.md §16：從源頭消除「清單外引用」噪音——spoke 自行縮寫路徑會被 §15
// 稽核標記為清單外，即使指的其實是清單內的檔案（issue_log_v2.0.md 2026-08-07 的真實案例）。
import path from "node:path";
import type { Lang } from "./types.js";

// 英文工單走這一份。內容與中文版逐條對應——同樣先「觀察／依據／原文」，同樣以固定收尾句
// 結束，因為稽核靠那句話判斷回報有沒有寫完。翻譯時刻意保留祈使句與「原文是主要依據、
// 行號是輔助」這兩處措辭：實測顯示 spoke 對句型敏感，描述句會被當成建議略過。
const REPORT_TEMPLATE_EN = `# Observations
1. <observation>
   Evidence: <file:line, or explicit reasoning>
   Quote: <when citing a file, copy that one line verbatim; write "reasoning" when the evidence is reasoning>
   —— when citing a file, the path must match the string in "Allowed reads" character for character; do not abbreviate it or write the filename alone.
   —— **the quote is the primary evidence, the line number is secondary**: the hub locates the
     real position by matching the quote, so quote verbatim. Copy only the line you are sure
     of rather than rewriting one from memory.

# Cannot verify
- <files you needed but could not read, or gaps in the list>; write "none" if there are none

These are observations and questions. Whether to adopt them is for the hub and the user to decide.`;

const REPORT_TEMPLATE = `# 觀察
1. <觀察>
   依據：<檔案:行號 或 明確推理>
   原文：<引用檔案時，逐字複製該處的一行原文；依據為推理時寫「推理」>
   ——引用檔案時，路徑須與「允許讀取」清單中的字串逐字相同，不得縮寫或只寫檔名。
   ——**原文是主要依據，行號是輔助**：hub 會用原文比對出實際位置，所以原文必須逐字，
     寧可只複製確定的那一行，也不要憑印象重寫。

# 無法驗證
- <需要但讀不到的檔案，或清單不足之處>；沒有則寫「無」

以上為觀察與問題，採用與否由 hub 與使用者裁決。`;

// plan_dispatch_v2.1.md §8（二）：工具說明只提「工單」，從未說允許清單的程式碼也要讀——
// 零讀取的第二個成因（issue_log_v2.0.md 2026-08-07「provider 端完整 log」）。
const TOOL_NOTE = "你有一個工具 `read_file(path)`。工單與允許讀取的程式碼檔案都不在本 prompt 中，\n須自行讀取；未讀過的檔案不得出現在「依據」中。";
const TOOL_NOTE_EN = "You have one tool, `read_file(path)`. Neither the ticket nor the code files you are\nallowed to read are in this prompt; read them yourself. A file you have not read must not\nappear in \"Evidence\".";

// plan_dispatch_v2.1.md §8（二）：組裝順序改為 agent body → 工具說明 → 回報模板。原順序
// （agent body → 回報模板 → 工具說明）讓工具說明掉在回報模板的固定收尾句之後，在結構上
// 像附註——而那正是唯一說明「你有工具」的段落（provider log system-1.txt 全文證實）。
// plan_i18n_v1.3.md §一之2：不設預設值——不是安全網（九個既有呼叫端都已顯式傳值，
// 一個都不會紅），是防未來新增的呼叫端靜默拿到與產品預設（en）相反的值。
export function buildSystemPrompt(agentBody: string, lang: Lang): string {
  const toolNote = lang === "en" ? TOOL_NOTE_EN : TOOL_NOTE;
  const template = lang === "en" ? REPORT_TEMPLATE_EN : REPORT_TEMPLATE;
  return [agentBody.trim(), toolNote, template].join("\n\n");
}

// plan_dispatch_v2.1.md §8（一）：步驟 3 原為「需要時讀取」的條件句、且未列路徑——provider
// log 顯示模型嚴格照句型行事，命令句（步驟 1、2）會執行、條件句（步驟 3）不會。改為與
// 步驟 1、2 同句型的命令句，並逐條列出允許清單路徑。綁定條件是「要引用就必須先讀」，不是
// 「必須讀完整份清單」——清單寧寬勿窄時硬性全讀會浪費 token，且與 §7「被拒呼叫仍計入
// --max-tool-calls」的成本模型衝突。
function buildStep3(allowedReadsRelative: string[], lang: Lang): string {
  if (allowedReadsRelative.length === 0) {
    return lang === "en"
      ? "3. There are no readable files this time; answer from the section under review alone."
      : "3. 本次無允許讀取檔案，僅依待審段落作答。";
  }
  const head =
    lang === "en"
      ? "3. read_file each of the files below — any file you intend to cite in \"Evidence\" must be read first:"
      : "3. 逐一 read_file 下列檔案——凡是要在「依據」中引用的檔案，必須先讀過：";
  return [head, ...allowedReadsRelative.map((p) => `   - ${p}`)].join("\n");
}

// issue_log_v2.1.md：步驟 1、2 給絕對路徑、步驟 3 給相對路徑，spoke 看到兩種格式就會混用
// ——引用時寫成絕對路徑，稽核便判為「清單外引用」。第 7 次派工 11 筆、第 9 次 7 筆全是這種
// 噪音，而第 9 次同一欄裡還混著 2 筆「真的沒給檔」，假警報淹沒了真訊號。統一成相對路徑後
// spoke 全程只看得到一種格式。白名單那側本來就兩種都收（whitelist.ts:37 走
// path.resolve(repoRoot, requested)），故不需配合修改。
//
// 但工單目錄**不保證位於 repoRoot 內**——cli.ts 明文「工單目錄仍相對 cwd 解析，不要求位於
// repoRoot 內」。在外時轉相對會得到 ../.. 這種更難讀、也更容易被誤用的字串，故維持絕對。
function displayTicketDir(ticketDir: string, repoRoot?: string): string {
  if (!repoRoot) return ticketDir;
  const rel = path.relative(repoRoot, ticketDir);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return ticketDir;
  return rel;
}

export function buildFirstUserText(
  ticketDir: string,
  agent: string,
  allowedReadsRelative: string[],
  repoRoot: string | undefined,
  lang: Lang,
): string {
  const dir = displayTicketDir(ticketDir, repoRoot);
  if (lang === "en") {
    return `Do these in order:
1. read_file("${dir}/_shared.md") — the premises and the section under review
2. read_file("${dir}/${agent}.md") — your questions and your list of readable files
${buildStep3(allowedReadsRelative, lang)}
4. Produce your report in the template given in the system prompt

Paths in "Allowed reads" are relative to the repo root, not to the ticket directory.
Files outside the list are refused. Do not retry a refused file; record what is missing
under "Cannot verify".`;
  }
  return `依序執行：
1. read_file("${dir}/_shared.md") — 取得前提與待審段落
2. read_file("${dir}/${agent}.md") — 取得你的具體問題與允許讀取清單
${buildStep3(allowedReadsRelative, lang)}
4. 依 system prompt 的回報模板產出

「允許讀取」清單內的路徑相對於 repo 根目錄，不是相對於工單目錄。
清單外的檔案會被拒絕。被拒時不要重試，在「無法驗證」欄記下缺什麼。`;
}

export function buildFinalizeUserText(lang: Lang): string {
  return lang === "en"
    ? "You have reached the execution limit. Produce your report now from what you already have; do not call any more tools."
    : "已達執行上限，請依現有資訊直接產出目前的回報，不要再呼叫工具。";
}
