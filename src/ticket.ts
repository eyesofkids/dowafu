// plan_dispatch_v1.4.md §4：工單目錄解析。純函式（吃 markdown 字串、吐結構化資料），
// 檔案系統存取另外在 loadTicket() 做，方便單元測試不必 mock 檔案系統。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { DispatchError, type Lang } from "./types.js";
import { m } from "./messages.js";

export type DispatchRow = {
  agent: string;
  provider: string;
  model: string;
  effort?: string;
};

export type SharedDoc = {
  premises: string[];
  reviewText: string;
};

// 語言曾經由工單的區塊標記決定（使用者裁示 2026-08-10：語言不另設旗標；理由是旗標會被
// 忘記，忘了的後果不是報錯、是「英文問題配中文模板」）。**該裁示已被
// plan_i18n_v1.3.md §一之5 推翻**：改為 run-level `--lang`／`DISPATCH_LANG` 決定語言
// （見 validate.ts 的 resolveSpokes），與工單標記無關。中英兩套區塊標記仍並存解析
// （下方 parseAgentTicket）——那是選欄位鍵用的別名，拿掉英文那套英文工單會直接解析
// 失敗，跟語言選擇是兩回事。run-level 語言型別（原 TicketLang，T7a 更名為 Lang）已搬去
// types.ts——它代表的是這個東西而非工單本身的語言，留在 ticket.ts 名實不符；本檔下方
// 函式簽名仍需要它，故從 types.js 匯入。AgentTicket 本身已不再持有語言欄位。

export type AgentTicket = {
  questions: string;
  allowedReads: string[];
};

export type Ticket = {
  ticketDir: string;
  rows: DispatchRow[];
  shared: SharedDoc;
  perAgent: Map<string, AgentTicket>;
};

const FORMAT_MARKER = "<!-- format: v1 -->";

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
}

// §4：`_dispatch.md`。model/provider/agent 必填，無預設值；留白或寫 "default" 視為缺失。
export function parseDispatchTable(markdown: string, lang: Lang): DispatchRow[] {
  const lines = markdown.split(/\r?\n/);
  const firstNonBlank = lines.find((l) => l.trim().length > 0);
  if (firstNonBlank?.trim() !== FORMAT_MARKER) {
    throw new DispatchError(
      m(lang, "formatMarkerMismatch", FORMAT_MARKER, firstNonBlank?.trim() ?? m(lang, "blankPlaceholder")),
      2,
    );
  }

  const headerIndex = lines.findIndex((l) => /^\s*\|\s*agent\s*\|/i.test(l));
  if (headerIndex === -1 || !isSeparatorRow(splitTableRow(lines[headerIndex + 1] ?? ""))) {
    throw new DispatchError(m(lang, "dispatchTableMissingHeader"), 2);
  }

  const headerCells = splitTableRow(lines[headerIndex]).map((c) => c.toLowerCase());
  const rows: DispatchRow[] = [];
  for (let i = headerIndex + 2; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim().startsWith("|")) break;
    const cells = splitTableRow(line);
    const get = (col: string) => {
      const idx = headerCells.indexOf(col);
      return idx === -1 ? "" : (cells[idx] ?? "").trim();
    };

    const agent = get("agent");
    const provider = get("provider");
    const model = get("model");
    const effort = get("effort");

    const isMissing = (v: string) => v.length === 0 || v.toLowerCase() === "default";
    if (isMissing(agent) || isMissing(provider) || isMissing(model)) {
      throw new DispatchError(m(lang, "dispatchRowMissingFields", i + 1, line), 2);
    }

    rows.push({ agent, provider, model, effort: effort.length > 0 ? effort : undefined });
  }

  if (rows.length === 0) {
    throw new DispatchError(m(lang, "dispatchTableEmpty"), 2);
  }
  return rows;
}

// plan_i18n_v1.2.md §6.2：「讀檔 → 剝 frontmatter → trim」這個片段跨多處共用（原為
// validate.ts 私有），放這裡不產生循環——audit.ts 已經 import 本檔。
export function stripFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return (match ? match[1] : markdown).trim();
}

// 匯出供 audit.ts 重用（回報模板同樣是 `# 標題` 結構）。
export function splitTopLevelSections(markdown: string): Map<string, string> {
  const lines = markdown.split(/\r?\n/);
  const sections = new Map<string, string>();
  let currentHeading: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (currentHeading !== null) {
      sections.set(currentHeading, buffer.join("\n").trim());
    }
  };

  for (const line of lines) {
    const match = line.match(/^#\s+(.+?)\s*$/);
    if (match) {
      flush();
      currentHeading = match[1];
      buffer = [];
    } else if (currentHeading !== null) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

function parseBulletList(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((l) => l.match(/^-\s+(.+)$/)?.[1]?.trim())
    .filter((v): v is string => Boolean(v && v.length > 0));
}

// §4：`_shared.md`。「待審段落」缺失或空即中止；「前提」缺失為警告（空前提合法）。
export function parseSharedDoc(markdown: string, lang: Lang): SharedDoc {
  const sections = splitTopLevelSections(markdown);

  const reviewText = sections.get("待審段落") ?? sections.get("Under review");
  if (!reviewText || reviewText.length === 0) {
    // issue_log_v2.1.md：這個錯誤實測撞過兩次，而兩次的成因都不是「忘了寫」——是內嵌的
    // 規劃書自帶 `#` 標題，被 splitTopLevelSections 當成新區塊，把待審段落切斷了。
    // 原訊息「缺或內容為空」會讓人先去查自己有沒有寫，方向就錯了。標題存在卻空白時，
    // 直接指名是誰切斷了它。
    if (sections.has("待審段落") || sections.has("Under review")) {
      const stray = [...sections.keys()].filter(
        (k) => k !== "待審段落" && k !== "Under review" && !k.startsWith("前提") && k !== "Premises",
      );
      if (stray.length > 0) {
        throw new DispatchError(m(lang, "strayHeadingsCutReviewSection", stray), 2);
      }
    }
    throw new DispatchError(m(lang, "missingReviewSection"), 2);
  }

  const premisesBody = sections.get("前提（不受審）") ?? sections.get("前提") ?? sections.get("Premises");
  const premises = premisesBody ? parseBulletList(premisesBody) : [];

  return { premises, reviewText };
}

// §4：`<agent>.md`。「具體問題」缺失或空即中止；「允許讀取」缺失為警告（空清單合法）。
export function parseAgentTicket(markdown: string, lang: Lang): AgentTicket {
  const sections = splitTopLevelSections(markdown);

  // 先中文後英文：命中哪一套只決定用哪一組欄位鍵去讀值——不再代表語言選擇，語言改由
  // run-level `--lang` 決定（見上方型別註解、plan_i18n_v1.3.md §一之5）。
  const zhQuestions = sections.get("具體問題");
  const enQuestions = sections.get("Questions");
  const questions = zhQuestions ?? enQuestions;
  if (!questions || questions.length === 0) {
    throw new DispatchError(m(lang, "missingQuestionsSection"), 2);
  }

  const allowedBody = sections.get("允許讀取") ?? sections.get("Allowed reads");
  const allowedReads = allowedBody ? parseBulletList(allowedBody) : [];

  return { questions, allowedReads };
}

// 檔案系統存取層：讀工單目錄、組出完整 Ticket。
export async function loadTicket(ticketDir: string, lang: Lang): Promise<Ticket> {
  const dispatchPath = path.join(ticketDir, "_dispatch.md");
  const sharedPath = path.join(ticketDir, "_shared.md");

  let dispatchText: string;
  try {
    dispatchText = await readFile(dispatchPath, "utf8");
  } catch {
    throw new DispatchError(m(lang, "fileNotFound", dispatchPath), 2);
  }
  let sharedText: string;
  try {
    sharedText = await readFile(sharedPath, "utf8");
  } catch {
    throw new DispatchError(m(lang, "fileNotFound", sharedPath), 2);
  }

  const rows = parseDispatchTable(dispatchText, lang);
  const shared = parseSharedDoc(sharedText, lang);

  const perAgent = new Map<string, AgentTicket>();
  for (const row of rows) {
    const agentPath = path.join(ticketDir, `${row.agent}.md`);
    let agentText: string;
    try {
      agentText = await readFile(agentPath, "utf8");
    } catch {
      throw new DispatchError(m(lang, "agentFileNotFound", agentPath, row.agent), 2);
    }
    perAgent.set(row.agent, parseAgentTicket(agentText, lang));
  }

  return { ticketDir, rows, shared, perAgent };
}
