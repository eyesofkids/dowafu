// plan_dispatch_v1.10.md §25：--json 輸出契約。純函式，把 SpokeRunResult／AuditResult
// 轉成 schema 定義的形狀——不在這裡做任何 I/O，方便不落地任何檔案就單元測試。
//
// 原文不進 JSON——維持 §16「stdout 只印摘要，不印原文」，hub 依「先原文、後融合」紀律
// 自行 Read 落檔。observationCount 保留 number | null（v1.9 §15），序列化時不得降級為 0。
//
// plan_dispatch_v1.11.md §25：新增 mode／plan／gitignoreStatus。`plan` 在步驟 6 之後
// 就已完全確定，三種 mode（dry-run／cancelled／executed）皆有，與是否實際執行無關；
// `spokes` 維持「執行結果」語意，dry-run／cancelled 時仍是空陣列——這是對的，不要改。

import type { AuditResult } from "./audit.js";
import type { BudgetTrigger, SpokeRunResult } from "./types.js";
import type { CliOptions, ProvidersSource } from "./report.js";
import { effectiveCap } from "./report.js";
import type { ResolvedSpoke } from "./validate.js";
import type { AllowlistEstimate, SpokeEstimate } from "./gate.js";
import type { GitignoreStatus } from "./gitignore-check.js";
import type { ToolCallAudit } from "./tool-call-audit.js";

export type JsonPlanEntry = {
  agent: string;
  provider: string;
  api: string;
  modelRequested: string;
  effort: string;
  store: "false" | "n/a" | "unknown";
  estimatedTokens: number;
  cap: number;
  allowlistEstimatedTokens: number; // §14：允許清單總量估算，只呈現不設閘門
  allowlistFileCount: number;
};

export type JsonMode = "dry-run" | "cancelled" | "executed";

export function buildJsonPlan(
  spokes: ResolvedSpoke[],
  estimates: SpokeEstimate[],
  allowlistEstimates: AllowlistEstimate[],
  cli: CliOptions,
): JsonPlanEntry[] {
  const estByAgent = new Map(estimates.map((e) => [e.agent, e.estimatedTokens]));
  const allowlistByAgent = new Map(allowlistEstimates.map((e) => [e.agent, e]));
  return spokes.map((spoke) => ({
    agent: spoke.agent,
    provider: spoke.provider,
    api: spoke.providerConfig.api,
    modelRequested: spoke.model,
    effort: spoke.effort,
    store: spoke.providerConfig.store === false ? "false" : "n/a",
    estimatedTokens: estByAgent.get(spoke.agent) ?? 0,
    cap: effectiveCap(spoke, cli),
    allowlistEstimatedTokens: allowlistByAgent.get(spoke.agent)?.estimatedTokens ?? 0,
    allowlistFileCount: allowlistByAgent.get(spoke.agent)?.fileCount ?? 0,
  }));
}

export type JsonSpoke = {
  agent: string;
  provider: string;
  api: string;
  modelRequested: string;
  modelReturned: string | null;
  effort: string;
  store: "false" | "n/a" | "unknown";
  status: string;
  budgetTrigger: BudgetTrigger | null;
  usage: SpokeRunResult["usage"];
  costUsd: number | null; // plan_fixes_v1.0.md §4：無價目資料時為 null，不是 0
  latencyMs: number;
  waitedMs: number;
  attempts: number;
  toolCalls: { total: number; allowed: number; rejected: number };
  audit: {
    closingLine: boolean;
    observationCount: number | null;
    pathsOutsideAllowlist: string[];
    hasUnverifiableSection: boolean;
    suspectMatches: string[];
    zeroSourceRead: boolean; // §15（一）：toolCalls 全落在工單目錄內，而允許清單非空
  };
};

export type JsonPayload = {
  ticketId: string;
  repoRoot: string;
  outDir: string;
  providersSource: ProvidersSource;
  mode: JsonMode;
  plan: JsonPlanEntry[];
  gitignoreStatus: GitignoreStatus;
  spokes: JsonSpoke[];
  exitCode: number;
};

export function buildJsonSpoke(
  result: SpokeRunResult,
  audit: AuditResult | undefined,
  toolCallAudit: ToolCallAudit | undefined,
): JsonSpoke {
  const allowed = result.toolCalls.filter((t) => t.allowed).length;
  return {
    agent: result.agent,
    provider: result.provider,
    api: result.api,
    modelRequested: result.modelRequested,
    modelReturned: result.modelReturned,
    effort: result.effort ?? "",
    store: result.store,
    status: result.status,
    budgetTrigger: result.budgetTrigger ?? null,
    usage: result.usage,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    waitedMs: result.waitedMs,
    attempts: result.attempts,
    toolCalls: {
      total: result.toolCalls.length,
      allowed,
      rejected: result.toolCalls.length - allowed,
    },
    audit: audit
      ? {
          closingLine: audit.finalLinePass,
          observationCount: audit.observationCount, // number | null 原樣保留，不得降級為 0
          pathsOutsideAllowlist: audit.citedPathsOutsideAllowlist,
          hasUnverifiableSection: audit.cannotVerifySectionPresent,
          suspectMatches: audit.suspectPhrases,
          zeroSourceRead: toolCallAudit?.zeroSourceRead ?? false,
        }
      : {
          closingLine: false,
          observationCount: null,
          pathsOutsideAllowlist: [],
          hasUnverifiableSection: false,
          suspectMatches: [],
          zeroSourceRead: toolCallAudit?.zeroSourceRead ?? false,
        },
  };
}

export function buildJsonPayload(args: {
  ticketId: string;
  repoRoot: string;
  outDir: string;
  providersSource: ProvidersSource;
  mode: JsonMode;
  plan: JsonPlanEntry[];
  gitignoreStatus: GitignoreStatus;
  results: SpokeRunResult[];
  audits: Map<string, AuditResult>;
  toolCallAudits: Map<string, ToolCallAudit>;
  exitCode: number;
}): JsonPayload {
  return {
    ticketId: args.ticketId,
    repoRoot: args.repoRoot,
    outDir: args.outDir,
    providersSource: args.providersSource,
    mode: args.mode,
    plan: args.plan,
    gitignoreStatus: args.gitignoreStatus,
    spokes: args.results.map((r) => buildJsonSpoke(r, args.audits.get(r.agent), args.toolCallAudits.get(r.agent))),
    exitCode: args.exitCode,
  };
}
