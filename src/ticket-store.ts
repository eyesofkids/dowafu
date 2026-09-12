import { readFile } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DispatchError, type Lang } from "./types.js";
import { m } from "./messages.js";
import { isReservedTicketName, reservedTicketNames } from "./cli-commands.js";
import { now } from "./db.js";
import { parseAgentTicket, parseDispatchTable } from "./ticket.js";
import { isModelEnabled, loadProviders } from "./providers-store.js";
import { getCommandName } from "./pkg-info.js";
import { formatModelPricing } from "./report.js";
import { DEFAULT_MAX_TOOL_CALLS, estimateHardCapUsd } from "./cost.js";
import type { ModelPricing } from "./types.js";

export type StoredAllow = { path: string; content: string };
export type StoredSpoke = { agent: string; provider: string; model: string; effort?: string; body: string; allow: StoredAllow[] };
export type StoredTicketDoc = { shared: string; spokes: StoredSpoke[] };

function parseDoc(raw: string, name: string, lang: Lang): StoredTicketDoc {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !Array.isArray((value as StoredTicketDoc).spokes) || typeof (value as StoredTicketDoc).shared !== "string") throw new Error();
    return value as StoredTicketDoc;
  } catch {
    throw new DispatchError(m(lang, "ticketCorrupt", name), 2);
  }
}

export function getTicketDoc(db: DatabaseSync, name: string, lang: Lang): StoredTicketDoc {
  const row = db.prepare("SELECT doc FROM tickets WHERE name = ?").get(name) as { doc?: string } | undefined;
  if (!row?.doc) throw new DispatchError(m(lang, "ticketNotFound", name), 2);
  return parseDoc(row.doc, name, lang);
}

function put(db: DatabaseSync, name: string, doc: StoredTicketDoc): void {
  db.prepare("UPDATE tickets SET doc = ? WHERE name = ?").run(JSON.stringify(doc), name);
}

export function createTicket(db: DatabaseSync, name: string, shared: string, lang: Lang): void {
  if (!name || name.includes(path.sep) || name === "." || name === "..") throw new DispatchError(m(lang, "ticketNameInvalid", name), 2);
  if (isReservedTicketName(name)) throw new DispatchError(m(lang, "ticketNameReserved", name, reservedTicketNames().join(", ")), 2);
  try {
    db.prepare("INSERT INTO tickets (name, doc, created_at) VALUES (?, ?, ?)").run(name, JSON.stringify({ shared, spokes: [] }), now());
  } catch {
    throw new DispatchError(m(lang, "ticketAlreadyExists", name), 2);
  }
}

export function addSpoke(db: DatabaseSync, name: string, spoke: Omit<StoredSpoke, "allow">, lang: Lang): void {
  const doc = getTicketDoc(db, name, lang);
  if (doc.spokes.some((item) => item.agent === spoke.agent)) throw new DispatchError(m(lang, "duplicateAgentInDispatchTable", spoke.agent, 2), 2);
  parseAgentTicket(spoke.body, lang);
  const providers = loadProviders(db, lang);
  // 熱修補（缺口三）：表整個是空的時候，「白名單為空」這句話會把人帶去查白名單，
  // 而該做的是把出貨檔匯進來。兩種成因要分開講。
  if (Object.keys(providers).length === 0) {
    throw new DispatchError(m(lang, "providersDbEmpty", getCommandName()), 2);
  }
  const provider = providers[spoke.provider];
  if (!provider || !provider.models.includes(spoke.model)) {
    throw new DispatchError(m(lang, "modelNotWhitelisted", spoke.agent, spoke.model, spoke.provider, provider?.models.join(", ") ?? ""), 2);
  }
  if (!isModelEnabled(db, spoke.provider, spoke.model)) throw new DispatchError(m(lang, "modelDisabled", spoke.model, getCommandName()), 6);
  doc.spokes.push({ ...spoke, allow: [] });
  put(db, name, doc);
}

function isUnderDocs(repoRoot: string, target: string): boolean {
  const docs = path.resolve(repoRoot, "_docs");
  return target === docs || target.startsWith(docs + path.sep);
}

export async function addAllow(db: DatabaseSync, name: string, agent: string, rel: string, repoRoot: string, lang: Lang): Promise<void> {
  const doc = getTicketDoc(db, name, lang);
  const spoke = doc.spokes.find((item) => item.agent === agent);
  if (!spoke) throw new DispatchError(m(lang, "ticketSpokeNotFound", name, agent), 2);
  const resolved = path.resolve(repoRoot, rel);
  if (isUnderDocs(repoRoot, resolved)) throw new DispatchError(m(lang, "allowedReadsUnderDocs", agent, rel), 2);
  try {
    fs.realpathSync(resolved);
  } catch {
    throw new DispatchError(m(lang, "allowedReadsPathNotFound", agent, rel), 2);
  }
  const content = await readFile(resolved, "utf8");
  const i = spoke.allow.findIndex((item) => item.path === rel);
  if (i >= 0) spoke.allow[i] = { path: rel, content };
  else spoke.allow.push({ path: rel, content });
  put(db, name, doc);
}

export async function importTicketDirectory(db: DatabaseSync, dir: string, name: string, repoRoot: string, lang: Lang): Promise<void> {
  const dispatch = await readFile(path.join(dir, "_dispatch.md"), "utf8");
  const shared = await readFile(path.join(dir, "_shared.md"), "utf8");
  const rows = parseDispatchTable(dispatch, lang);
  createTicket(db, name, shared, lang);
  try {
    for (const row of rows) {
      const body = await readFile(path.join(dir, `${row.agent}.md`), "utf8");
      addSpoke(db, name, { ...row, body }, lang);
      const parsed = parseAgentTicket(body, lang);
      for (const rel of parsed.allowedReads) await addAllow(db, name, row.agent, rel, repoRoot, lang);
    }
  } catch (err) {
    db.prepare("DELETE FROM tickets WHERE name = ?").run(name);
    throw err;
  }
}

type TicketPricing = { charsPerToken: number | null; pricing: ModelPricing | undefined; pricingAsOf: string | undefined };

function getTicketPricing(db: DatabaseSync, provider: string, model: string): TicketPricing {
  const row = db.prepare(
    `SELECT p.chars_per_token, p.pricing_source, m.input_per_m, m.cached_input_per_m, m.cache_write_per_m, m.output_per_m
       FROM providers p LEFT JOIN models m ON m.provider = p.name AND m.model = ?
      WHERE p.name = ?`,
  ).get(model, provider) as Record<string, unknown> | undefined;
  if (!row) return { charsPerToken: null, pricing: undefined, pricingAsOf: undefined };
  const hasPrice = row.input_per_m !== null && row.input_per_m !== undefined && row.output_per_m !== null && row.output_per_m !== undefined;
  let pricingAsOf: string | undefined;
  try {
    const source: unknown = row.pricing_source === null ? null : JSON.parse(String(row.pricing_source));
    if (source && typeof source === "object" && typeof (source as Record<string, unknown>).asOf === "string") {
      pricingAsOf = (source as Record<string, unknown>).asOf as string;
    }
  } catch {
    // A ticket summary must still disclose that this model lacks usable price metadata.
  }
  return {
    charsPerToken: row.chars_per_token === null || row.chars_per_token === undefined ? null : Number(row.chars_per_token),
    pricing: hasPrice
      ? {
          inputPerM: Number(row.input_per_m),
          outputPerM: Number(row.output_per_m),
          ...(row.cached_input_per_m === null || row.cached_input_per_m === undefined ? {} : { cachedInputPerM: Number(row.cached_input_per_m) }),
          ...(row.cache_write_per_m === null || row.cache_write_per_m === undefined ? {} : { cacheWritePerM: Number(row.cache_write_per_m) }),
        }
      : undefined,
    pricingAsOf,
  };
}

// 票 cost-cap §B 的估算輸入沿用「估算 X tokens」那個既有數字（允許清單內容大小，不是真正
// 的 systemPrompt＋firstUserText）——formatTicket 純吃 DB doc，沒有 repoRoot／lens 檔案系統
// 可讀，算不出 report.ts 那份真正的初始 prompt 估算。兩邊金額因此不會精確相等（這裡通常較大、
// 較保守），使用者已裁示接受這個落差（2026-09-06，「這估算都是高估為主的參考值」「本來就
// 不可能精確的一個值」）。
function estimateSpokeHardCapUsd(db: DatabaseSync, spoke: StoredSpoke, maxToolCalls: number): number | null {
  const chars = spoke.allow.reduce((sum, item) => sum + item.content.length, 0);
  const details = getTicketPricing(db, spoke.provider, spoke.model);
  const estimatedTokens = Math.ceil(chars / (details.charsPerToken ?? 1));
  return estimateHardCapUsd(estimatedTokens, maxToolCalls, details.pricing);
}

// 工單 approve-tool §A-1 之二：硬上限的數值出口——formatTicket 與 MCP 的 dispatch_approve
// 共用同一份算法，不得各算各的（否則「摘要上寫 $1.77、核准時卻說金額不符」，使用者無從判斷
// 誰對）。各 spoke 相加，缺任一 spoke 的價目資料就整體回 null，不得把「不知道」當 $0 相加。
export function getTicketHardCapUsd(db: DatabaseSync, name: string, lang: Lang, maxToolCalls: number = DEFAULT_MAX_TOOL_CALLS): number | null {
  const doc = getTicketDoc(db, name, lang);
  const parts = doc.spokes.map((spoke) => estimateSpokeHardCapUsd(db, spoke, maxToolCalls));
  return parts.some((p) => p === null) ? null : (parts as number[]).reduce((sum, p) => sum + p, 0);
}

export function formatTicket(db: DatabaseSync, name: string, lang: Lang, maxToolCalls: number = DEFAULT_MAX_TOOL_CALLS): string {
  const doc = getTicketDoc(db, name, lang);
  const lines = [m(lang, "ticketShowHeader", name)];
  for (const spoke of doc.spokes) {
    const chars = spoke.allow.reduce((sum, item) => sum + item.content.length, 0);
    const details = getTicketPricing(db, spoke.provider, spoke.model);
    const estimatedTokens = Math.ceil(chars / (details.charsPerToken ?? 1));
    lines.push(`  ${spoke.agent}  ${spoke.provider}/${spoke.model}  allow=${spoke.allow.map((a) => a.path).join(", ") || "—"}  ${m(lang, "ticketEstimateTokens", estimatedTokens)}`);
    lines.push(`  ${details.pricing ? formatModelPricing(details.pricing, details.pricingAsOf, lang) : m(lang, "modelPricingMissing", spoke.model)}`);
    if (!details.pricing) lines.push(`  ${m(lang, "noPricingData")}`);
  }
  const reruns = db.prepare(
    `SELECT count(*) AS runs, sum(cost_usd) AS total, max(finished_at) AS last
       FROM jobs WHERE ticket = ? AND status = 'completed'`,
  ).get(name) as { runs: number; total: number | null; last: string | null };
  if (Number(reruns.runs) > 0) {
    if (reruns.total === null) lines.push(m(lang, "ticketCompletedRunsNoPricing", Number(reruns.runs), reruns.last ?? "—"));
    else lines.push(m(lang, "ticketCompletedRuns", Number(reruns.runs), reruns.total.toFixed(4), reruns.last ?? "—"));
  }

  const totalHardCapUsd = getTicketHardCapUsd(db, name, lang, maxToolCalls);
  if (totalHardCapUsd !== null) {
    // C-2：新工單（runs=0）或歷史 completed 全無可用價目資料（total===null）時，「典型」
    // 整段不出現，只印硬上限——不留任何代表 0 的佔位符。
    const runs = Number(reruns.runs);
    if (runs > 0 && reruns.total !== null) {
      lines.push(m(lang, "hardCapWithTypicalLine", (reruns.total / runs).toFixed(4), runs, totalHardCapUsd.toFixed(4)));
    } else {
      lines.push(m(lang, "hardCapLine", totalHardCapUsd.toFixed(4)));
    }
  } else {
    lines.push(m(lang, "hardCapMissingPricing"));
  }
  return lines.join("\n");
}

export function hasResults(db: DatabaseSync, ticket: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM results WHERE job_id = ? LIMIT 1").get(ticket));
}
