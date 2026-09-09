import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { defaultDbPath, openDb } from "../db.js";
import { approveJob, countTicketResultRuns, findJobsByIdPrefix, getJob, submitJob, type Job } from "../job.js";
import { DAEMON_STALE_MS, daemonAlive, daemonStatePath, daemonWarning, type DaemonLiveness } from "../liveness.js";
import { readProgress } from "../progress.js";
import { m } from "../messages.js";
import { readResultOutcomes, readResults } from "../output.js";
import { listModels } from "../providers-store.js";
import { buildKeyStatusRows, type KeyStatusRow } from "../provider-key.js";
import { getPackageVersion } from "../pkg-info.js";
import { formatTicket, getTicketDoc, getTicketHardCapUsd } from "../ticket-store.js";
import type { Lang } from "../types.js";

export type McpTool = {
  name: "dispatch_tickets" | "dispatch_submit" | "dispatch_status" | "dispatch_result" | "dispatch_approve";
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
};

export const TOOLS: McpTool[] = [
  {
    name: "dispatch_tickets",
    description: "List DB tickets that can be submitted, including their spokes and allowlist file counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dispatch_submit",
    description: "Queue a DB ticket by name. It remains pending human terminal approval and is not executed by this tool.",
    inputSchema: {
      type: "object",
      properties: {
        ticket: { type: "string", description: "DB ticket name, not a filesystem path" },
        lang: { type: "string", enum: ["en", "zh-tw", "zh"], description: "Language for this queued job's CLI output and spoke prompts" },
      },
      required: ["ticket"],
    },
  },
  {
    name: "dispatch_status",
    description: "Get a queued dispatch job's status.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
  },
  {
    name: "dispatch_result",
    description: "Get a completed dispatch job's stored spoke results, or report its current status.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
  },
  {
    name: "dispatch_approve",
    description:
      "Approve a dispatch job waiting in the queue so a worker daemon may claim it. Requires the job's hard-cap dollar amount (from dispatch_submit's summary) to match the database's own calculation; a mismatch is rejected and nothing is approved.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        hardCapUsd: { type: "string", description: "The hard-cap USD amount shown in the ticket summary, e.g. \"1.7712\" or \"$1.7712\"" },
      },
      required: ["jobId", "hardCapUsd"],
    },
  },
];

// 工單 C §E：讀 pkg-info 而非寫死版號——bump 之前會回報 package.json 目前的 0.4.1，
// 那是正確的，現在就是這個版本。
// 工單 approve-tool §零之二：本票推翻票 C 的禁令 #3，新增第五個 tool（dispatch_approve）。
// 「不得把 approve 開成 MCP tool」那條已作廢，見該工單。
export const SERVER_INFO = { name: "dowafu", version: getPackageVersion() };

type RpcId = string | number | null;
type RpcError = { code: number; message: string };
export type RpcResponse = { jsonrpc: "2.0"; id: RpcId; result?: unknown; error?: RpcError };
export type RpcOutcome = { response: RpcResponse } | { none: true };
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true };

export type ProtocolOptions = {
  db: DatabaseSync;
  dbPath: string;
  lang: Lang;
  liveness?: () => DaemonLiveness;
  // B（gaps #6）：running 期間要判斷心跳新不新鮮，需要一個時鐘。比照既有的 liveness 可注入。
  now?: () => number;
};

function text(value: string, isError?: true): ToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringParam(params: unknown, name: string): string | null {
  const value = record(params)?.[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Keep this acceptance and normalization identical to the CLI's --lang contract without
// importing cli-args.ts: cli-args imports the MCP HTTP transport, so sharing it here would
// create a protocol -> CLI args -> HTTP -> protocol runtime cycle.
function parseSubmitLang(value: string): Lang | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "en") return "en";
  if (normalized === "zh-tw" || normalized === "zh") return "zh";
  return null;
}

function keyStatusText(lang: Lang, row: KeyStatusRow): string {
  if (row.maskedTail === null) return m(lang, "keyStatusMissing");
  const configured = m(lang, "keyStatusDb", row.maskedTail, row.updatedAt ? row.updatedAt.slice(0, 10) : "");
  if (row.lastTestSucceeded === null || row.lastTestedAt === null || row.lastTestModel === null) return configured + m(lang, "keyStatusUntested");
  return configured + m(
    lang,
    row.lastTestSucceeded ? "keyStatusTestSucceeded" : "keyStatusTestFailed",
    row.lastTestModel,
    row.lastTestedAt.slice(0, 10),
  );
}

// 工單 approve-tool §A-1：比對容許格式差異（"$1.77" 與 "1.77"），但比對本身用
// getTicketHardCapUsd 同一份 toFixed(4) 精度，數值不符（含解析失敗）一律回 null 視為不符。
function parseUsdAmount(raw: string): number | null {
  const cleaned = raw.trim().replace(/^\$/, "");
  if (cleaned === "") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function requestId(message: Record<string, unknown>): RpcId | undefined {
  const id = message.id;
  return id === null || typeof id === "string" || typeof id === "number" ? id : undefined;
}

// 熱修補（票 C 手測）：MCP 的 jobId 也接受前綴。
//
// 票 B 的 B-1 #7 裁定「只有 CLI 接受前綴」。真 client 上跑一次就看到那個裁定的漏洞：
// `dispatch_submit` 的回傳文字裡印著核准指令 `approve b66b5d47`，Codex 因此拿 `b66b5d47`
// 去呼叫 `dispatch_result`，被回「找不到」——而那個 job 明明存在。**我們親手把 client
// 教去用一個自己不接受的形式。**
//
// 沿用 job.ts 的 findJobsByIdPrefix（票 B 刻意放在那裡，就是為了不要每個介面各寫一次），
// 歧義的處理與 CLI 一致：不猜，列出候選。job id 本身仍然不變，回傳的一律是完整 id。
function resolveJob(db: DatabaseSync, idOrPrefix: string): { job: Job } | { ambiguous: Job[] } | null {
  const exact = getJob(db, idOrPrefix);
  if (exact) return { job: exact };
  const matches = findJobsByIdPrefix(db, idOrPrefix);
  if (matches.length === 1) return { job: matches[0] };
  if (matches.length > 1) return { ambiguous: matches };
  return null;
}

export function createProtocol(options: ProtocolOptions) {
  const liveness = options.liveness ?? (() => daemonAlive(daemonStatePath(options.dbPath)));
  const warning = (): string | null => daemonWarning(liveness(), options.lang);

  const callTool = (name: string, args: unknown): ToolResult | null => {
    switch (name) {
      case "dispatch_tickets": {
        const names = options.db.prepare("SELECT name FROM tickets ORDER BY name").all() as Array<{ name: string }>;
        const lines = names.length === 0 ? [m(options.lang, "mcpTicketsEmpty")] : [m(options.lang, "mcpTicketsTitle")];
        for (const { name: ticket } of names) {
          const doc = getTicketDoc(options.db, ticket, options.lang);
          lines.push(m(options.lang, "mcpTicketsRow", ticket, doc.spokes.length));
          const priorRuns = countTicketResultRuns(options.db, ticket);
          if (priorRuns > 0) lines.push(`  ${m(options.lang, "mcpPriorResultsReminder", priorRuns)}`);
          for (const spoke of doc.spokes) {
            lines.push(m(options.lang, "mcpTicketsSpoke", spoke.agent, spoke.provider, spoke.model, spoke.allow.length));
          }
        }
        lines.push(m(options.lang, "mcpKeysTitle"));
        for (const row of buildKeyStatusRows(options.db)) lines.push(m(options.lang, "mcpKeysRow", row.provider, keyStatusText(options.lang, row)));
        lines.push(m(options.lang, "mcpEnabledModelsTitle"));
        for (const model of listModels(options.db).filter((model) => model.enabled)) {
          lines.push(m(options.lang, "mcpEnabledModelRow", model.provider, model.model));
        }
        return text(lines.join("\n"));
      }
      case "dispatch_submit": {
        const ticket = stringParam(args, "ticket");
        if (!ticket) return text("dispatch_submit requires a non-empty ticket name", true);
        const suppliedLang = record(args)?.lang;
        let jobLang: Lang | null = null;
        if (suppliedLang !== undefined) {
          if (typeof suppliedLang !== "string") return text(m(options.lang, "mcpSubmitInvalidLang", "(not a string)", m(options.lang, "availableLangValues")), true);
          jobLang = parseSubmitLang(suppliedLang);
          if (jobLang === null) return text(m(options.lang, "mcpSubmitInvalidLang", suppliedLang, m(options.lang, "availableLangValues")), true);
        }
        try {
          const priorRuns = countTicketResultRuns(options.db, ticket);
          const job = submitJob(options.db, ticket, undefined, jobLang);
          const cliPath = path.resolve(process.argv[1] ?? "cli.js");
          const approveCommand = `node ${JSON.stringify(cliPath)} approve ${job.id.slice(0, 8)} --db ${JSON.stringify(options.dbPath)}`;
          const lines = [m(options.lang, "mcpSubmitQueued", job.id), m(options.lang, "mcpApproveCommand", approveCommand), formatTicket(options.db, ticket, options.lang)];
          if (priorRuns > 0) lines.push(m(options.lang, "mcpPriorResultsReminder", priorRuns));
          const offline = warning();
          if (offline) lines.push(offline);
          return text(lines.join("\n"));
        } catch (err) {
          return text(err instanceof Error ? err.message : String(err), true);
        }
      }
      case "dispatch_status": {
        const jobId = stringParam(args, "jobId");
        if (!jobId) return text("dispatch_status requires a non-empty jobId", true);
        const found = resolveJob(options.db, jobId);
        if (!found) return text(m(options.lang, "jobNotFound", jobId), true);
        if ("ambiguous" in found) {
          return text([m(options.lang, "mcpJobPrefixAmbiguous", jobId, found.ambiguous.length),
            ...found.ambiguous.map((candidate) => `  ${candidate.id}  ${candidate.ticket}  ${candidate.status}`)].join("\n"), true);
        }
        const job = found.job;
        const lines = [`job ${job.id}: ${job.status}`];
        if (job.claimed_at) lines.push(m(options.lang, "mcpJobStarted", job.claimed_at));
        if (job.finished_at) lines.push(m(options.lang, "mcpJobFinished", job.finished_at));
        if (job.error) lines.push(m(options.lang, "mcpJobError", job.error));
        if (job.status === "pending_approval" || job.status === "approved") {
          const offline = warning();
          if (offline) lines.push(offline);
        }
        // B（gaps #6）：進了 running 之後先前反而什麼都不講——而那正是最需要講的時候。
        // 兩個不同的問題各自回答：進度（有在往前走嗎）與心跳（worker 還活著嗎）。
        // 卡在 429 重試會長成「心跳新鮮、進度不動」，行程死掉則是兩個都停。
        if (job.status === "running") {
          const progress = readProgress(options.db, job.id);
          if (progress.length === 0) lines.push(m(options.lang, "mcpJobNoProgressYet"));
          for (const p of progress) {
            lines.push(m(options.lang, "mcpJobProgress", p.agent, p.lastRound, p.tokensIn, p.tokensOut, p.lastAt));
          }
          const staleMs = job.heartbeat_at ? (options.now ?? Date.now)() - Date.parse(job.heartbeat_at) : null;
          if (staleMs === null || staleMs > DAEMON_STALE_MS) {
            lines.push(m(options.lang, "mcpJobHeartbeatStale", Math.round((staleMs ?? 0) / 1000)));
          }
        }
        // 工單 status-stdin §A-3：CLI 子行程只在全部 spoke 都失敗時才回非零 exit
        // （見 cli.ts 的 allFailed 判定），三支死一支照樣 exit 0、job 標成 completed——
        // 先前只印 `job <id>: completed`，看不出哪幾支付了錢卻沒拿到東西。failed 的 job
        // 也要（先前只印子行程的 exit 訊息，看不出是哪一支出事）。
        if (job.status === "completed" || job.status === "failed") {
          const outcomes = readResultOutcomes(options.db, job.id);
          if (outcomes.length > 0) {
            const failedAgents = outcomes.filter((o) => o.failed).map((o) => o.agent);
            const succeeded = outcomes.length - failedAgents.length;
            const failedAgentsSuffix = failedAgents.length > 0 ? m(options.lang, "mcpJobFailedAgentsSuffix", failedAgents.join(", ")) : "";
            lines.push(m(options.lang, "mcpJobOutcome", succeeded, failedAgents.length, failedAgentsSuffix));
          }
        }
        return text(lines.join("\n"));
      }
      case "dispatch_result": {
        const jobId = stringParam(args, "jobId");
        if (!jobId) return text("dispatch_result requires a non-empty jobId", true);
        const found = resolveJob(options.db, jobId);
        if (!found) return text(m(options.lang, "jobNotFound", jobId), true);
        if ("ambiguous" in found) {
          return text([m(options.lang, "mcpJobPrefixAmbiguous", jobId, found.ambiguous.length),
            ...found.ambiguous.map((candidate) => `  ${candidate.id}  ${candidate.ticket}  ${candidate.status}`)].join("\n"), true);
        }
        const job = found.job;
        if (job.status !== "completed") {
          const lines = [m(options.lang, "mcpResultPending", job.id, job.status)];
          if (job.error) lines.push(m(options.lang, "mcpJobError", job.error));
          return text(lines.join("\n"));
        }
        // 驗收熱修補：同 cli.ts 的 result 分支——lang 不傳的話失敗字樣固定英文。
        const results = readResults(options.db, job.id, options.lang);
        return text([m(options.lang, "mcpResultComplete", job.id), ...(results.length ? results : [m(options.lang, "mcpResultEmpty")])].join("\n"));
      }
      case "dispatch_approve": {
        const jobId = stringParam(args, "jobId");
        if (!jobId) return text("dispatch_approve requires a non-empty jobId", true);
        const hardCapUsdRaw = stringParam(args, "hardCapUsd");
        if (!hardCapUsdRaw) return text("dispatch_approve requires a hardCapUsd amount", true);
        const found = resolveJob(options.db, jobId);
        if (!found) return text(m(options.lang, "jobNotFound", jobId), true);
        if ("ambiguous" in found) {
          return text([m(options.lang, "mcpJobPrefixAmbiguous", jobId, found.ambiguous.length),
            ...found.ambiguous.map((candidate) => `  ${candidate.id}  ${candidate.ticket}  ${candidate.status}`)].join("\n"), true);
        }
        const job = found.job;
        // 工單 §A-1 之二：與 formatTicket 共用同一份算法（getTicketHardCapUsd），不得在這裡
        // 另算一份——變異 #5 鎖這件事。
        const expected = getTicketHardCapUsd(options.db, job.ticket, options.lang);
        if (expected === null) return text(m(options.lang, "mcpApproveNoPricing", job.id), true);
        const provided = parseUsdAmount(hardCapUsdRaw);
        if (provided === null || provided.toFixed(4) !== expected.toFixed(4)) {
          return text(m(options.lang, "mcpApproveAmountMismatch", job.id, hardCapUsdRaw, expected.toFixed(4)), true);
        }
        const approved = approveJob(options.db, job.id);
        if (!approved) return text(m(options.lang, "jobNotApprovable", job.id, job.status), true);
        const lines = [m(options.lang, "jobApproved", approved.id)];
        const offline = warning();
        if (offline) lines.push(offline);
        return text(lines.join("\n"));
      }
      default:
        return null;
    }
  };

  const handleRpc = (raw: unknown, log: (line: string) => void = () => {}): RpcOutcome => {
    const message = record(raw);
    if (!message || typeof message.method !== "string") {
      return { response: { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } } };
    }
    const id = requestId(message);
    const respond = (result: unknown): RpcOutcome => (id === undefined ? { none: true } : { response: { jsonrpc: "2.0", id, result } });
    const fail = (code: number, message: string): RpcOutcome =>
      id === undefined ? { none: true } : { response: { jsonrpc: "2.0", id, error: { code, message } } };

    if (message.method.startsWith("notifications/")) return { none: true };
    if (message.method === "server/discover") return fail(-32601, "server/discover not implemented (legacy server)");
    if (message.method === "initialize") {
      const params = record(message.params);
      log(`clientInfo: ${JSON.stringify(params?.clientInfo ?? null)}`);
      log(`protocolVersion: ${JSON.stringify(params?.protocolVersion ?? null)}`);
      log(`capabilities: ${JSON.stringify(params?.capabilities ?? null)}`);
      return respond({
        protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    if (message.method === "ping") return respond({});
    if (message.method === "tools/list") return respond({ tools: TOOLS });
    if (message.method === "tools/call") {
      const params = record(message.params);
      const name = typeof params?.name === "string" ? params.name : "";
      const result = callTool(name, params?.arguments);
      return result ? respond(result) : fail(-32602, `unknown tool: ${name}`);
    }
    return fail(-32601, `method not found: ${message.method}`);
  };

  return { handleRpc, callTool };
}

export function createDefaultProtocol(dbPath: string = defaultDbPath(), lang: Lang = "en") {
  return createProtocol({ db: openDb(dbPath), dbPath, lang });
}
