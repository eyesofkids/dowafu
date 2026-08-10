// plan_dispatch_v1.4.md §4：工單目錄解析。純函式（吃 markdown 字串、吐結構化資料），
// 檔案系統存取另外在 loadTicket() 做，方便單元測試不必 mock 檔案系統。

import { readFile } from "node:fs/promises";
import path from "node:path";
import { DispatchError } from "./types.js";

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

// 工單的區塊標記有中英兩套，**由工單自己用哪一套決定這支 spoke 收到哪種語言的 prompt
// 與回報模板**（使用者裁示 2026-08-10：語言不另設旗標）。理由是旗標會被忘記，而忘了的
// 後果不是報錯、是「英文問題配中文模板」——spoke 照英文作答，稽核逐字比對中文收尾句，
// 整份判 fail。標記與模板同源，就不可能對不起來。
export type TicketLang = "zh" | "en";

export type AgentTicket = {
  questions: string;
  allowedReads: string[];
  lang: TicketLang;
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
export function parseDispatchTable(markdown: string): DispatchRow[] {
  const lines = markdown.split(/\r?\n/);
  const firstNonBlank = lines.find((l) => l.trim().length > 0);
  if (firstNonBlank?.trim() !== FORMAT_MARKER) {
    throw new DispatchError(
      `_dispatch.md 首行須為 ${FORMAT_MARKER}，實際為：${firstNonBlank?.trim() ?? "(空白)"}`,
      2,
    );
  }

  const headerIndex = lines.findIndex((l) => /^\s*\|\s*agent\s*\|/i.test(l));
  if (headerIndex === -1 || !isSeparatorRow(splitTableRow(lines[headerIndex + 1] ?? ""))) {
    throw new DispatchError("_dispatch.md 找不到派工表（缺 | agent | ... | 表頭或分隔列）", 2);
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
      throw new DispatchError(
        `_dispatch.md 第 ${i + 1} 行缺 agent/provider/model 必填欄位（留白或寫 "default" 視為缺失）：${line}`,
        2,
      );
    }

    rows.push({ agent, provider, model, effort: effort.length > 0 ? effort : undefined });
  }

  if (rows.length === 0) {
    throw new DispatchError("_dispatch.md 派工表沒有任何資料列", 2);
  }
  return rows;
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
export function parseSharedDoc(markdown: string): SharedDoc {
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
        throw new DispatchError(
          `_shared.md 的「# 待審段落」有標題但內容為空——被後面這些 \`#\` 標題切斷了：` +
            `${stray.map((s) => `「# ${s}」`).join("、")}。` +
            `工單以 \`#\` 切分區塊，內嵌的規劃書若自帶 \`#\` 標題請降成 \`##\`。` +
            `（注意：在「# 待審段落」下面補一行文字雖然能通過檢查，但規劃書本體仍會留在` +
            `後面那個區塊裡，spoke 收到的待審段落等於是空的。）`,
          2,
        );
      }
    }
    throw new DispatchError('_shared.md 缺「# 待審段落」（或英文工單的「# Under review」）或內容為空', 2);
  }

  const premisesBody = sections.get("前提（不受審）") ?? sections.get("前提") ?? sections.get("Premises");
  const premises = premisesBody ? parseBulletList(premisesBody) : [];

  return { premises, reviewText };
}

// §4：`<agent>.md`。「具體問題」缺失或空即中止；「允許讀取」缺失為警告（空清單合法）。
export function parseAgentTicket(markdown: string): AgentTicket {
  const sections = splitTopLevelSections(markdown);

  // 先中文後英文。命中哪一套就是這份工單的語言——不看內文，只看標記，因為內文可能
  // 中英混雜（英文規劃書配中文問題是常見寫法），標記則是作者明確選的。
  const zhQuestions = sections.get("具體問題");
  const enQuestions = sections.get("Questions");
  const lang: TicketLang = zhQuestions !== undefined ? "zh" : enQuestions !== undefined ? "en" : "zh";
  const questions = zhQuestions ?? enQuestions;
  if (!questions || questions.length === 0) {
    throw new DispatchError('<agent>.md 缺「# 具體問題」（或英文工單的「# Questions」）或內容為空', 2);
  }

  const allowedBody = sections.get("允許讀取") ?? sections.get("Allowed reads");
  const allowedReads = allowedBody ? parseBulletList(allowedBody) : [];

  return { questions, allowedReads, lang };
}

// 檔案系統存取層：讀工單目錄、組出完整 Ticket。
export async function loadTicket(ticketDir: string): Promise<Ticket> {
  const dispatchPath = path.join(ticketDir, "_dispatch.md");
  const sharedPath = path.join(ticketDir, "_shared.md");

  let dispatchText: string;
  try {
    dispatchText = await readFile(dispatchPath, "utf8");
  } catch {
    throw new DispatchError(`找不到 ${dispatchPath}`, 2);
  }
  let sharedText: string;
  try {
    sharedText = await readFile(sharedPath, "utf8");
  } catch {
    throw new DispatchError(`找不到 ${sharedPath}`, 2);
  }

  const rows = parseDispatchTable(dispatchText);
  const shared = parseSharedDoc(sharedText);

  const perAgent = new Map<string, AgentTicket>();
  for (const row of rows) {
    const agentPath = path.join(ticketDir, `${row.agent}.md`);
    let agentText: string;
    try {
      agentText = await readFile(agentPath, "utf8");
    } catch {
      throw new DispatchError(`找不到 ${agentPath}（_dispatch.md 列了 agent "${row.agent}"）`, 2);
    }
    perAgent.set(row.agent, parseAgentTicket(agentText));
  }

  return { ticketDir, rows, shared, perAgent };
}
