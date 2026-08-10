#!/usr/bin/env node
// plan_dispatch_v1.4.md §9/§10：CLI 入口，串起 §10 執行流程 1–10。
// plan_dispatch_v1.10.md §10：新增步驟 0（設定解析）與步驟 6.5（gitignore 三態檢查），
// 皆在任何 API 呼叫之前。引數解析、說明文字、事件格式化拆到 cli-args.ts（純函式，
// 供單元測試）；此檔只負責串接與 I/O。

import path from "node:path";
import { createInterface } from "node:readline/promises";
import { DispatchError, type Adapter } from "./types.js";
import { loadTicket } from "./ticket.js";
import { loadProviders, PROVIDERS_FORMAT_VERSION } from "./providers.js";
import { resolveSpokes, type ResolvedSpoke } from "./validate.js";
import { estimateTokens, estimateAllowlistTokens, estimateSequentialRead, checkGateOne, type SpokeEstimate, type AllowlistEstimate } from "./gate.js";
import { buildFirstUserText, buildSystemPrompt } from "./prompt.js";
import { buildReport, effectiveCap, effectiveCharsPerToken, type ProvidersSource } from "./report.js";
import { runSpoke, type RunEvent } from "./runner.js";
import { Semaphore } from "./semaphore.js";
import { createResponsesAdapter } from "./adapters/responses.js";
import { createGeminiAdapter } from "./adapters/gemini-native.js";
import { createAnthropicAdapter } from "./adapters/anthropic-messages.js";
import { auditSpoke } from "./audit.js";
import { auditToolCalls, type ToolCallAudit } from "./tool-call-audit.js";
import { ensureOutDir, persistSpokeResult, RunLogWriter, writeSummary } from "./output.js";
import { registerSecrets, maskString, maskDeep } from "./mask.js";
import { SECRET_ENV_VARS } from "./secret-env.js";
import { resolveDispatchHome, loadDispatchEnv } from "./dispatch-home.js";
import { bundledProvidersPath, getPackageVersion } from "./pkg-info.js";
import { checkGitignore } from "./gitignore-check.js";
import { buildJsonPayload, buildJsonPlan } from "./json-output.js";
import { parseArgs, formatEvent, HELP_TEXT } from "./cli-args.js";
import type { SpokeRunResult } from "./types.js";

function createAdapterFor(spoke: ResolvedSpoke): Adapter {
  const apiKey = process.env[`${spoke.provider.toUpperCase()}_API_KEY`];
  if (!apiKey) {
    // resolveSpokes 已檢查過，此處為型別窄化防禦
    throw new DispatchError(`內部錯誤：${spoke.provider} 的 API key 遺失`, 2);
  }
  // §29 規格十：窮盡式分派，不留「其餘落到 gemini」的 fallback——那會讓未來第四家 provider
  // 靜默走錯 adapter。switch 缺 case 時 TypeScript 因「不是每條路徑都回傳值」編譯失敗。
  switch (spoke.providerConfig.api) {
    case "responses":
      return createResponsesAdapter({
        baseURL: spoke.providerConfig.baseURL,
        apiKey,
        store: spoke.providerConfig.store,
        reasoning: spoke.providerConfig.reasoning,
      });
    case "gemini-native":
      return createGeminiAdapter({ apiKey, baseURL: spoke.providerConfig.baseURL });
    case "anthropic-messages":
      return createAnthropicAdapter({
        baseURL: spoke.providerConfig.baseURL,
        apiKey,
        reasoning: spoke.providerConfig.reasoning,
      });
  }
}

// v1.10 §25：--json 下，人類可讀輸出（報表／即時事件／摘要）全部改走 stderr，stdout
// 只留給最後那個單一 JSON 物件。錯誤訊息本來就走 stderr（既有行為），不受此影響。
type Logger = { info: (msg: string) => void };
function makeLogger(json: boolean): Logger {
  return { info: (msg: string) => (json ? console.error(msg) : console.log(msg)) };
}

async function confirm(message: string, output: NodeJS.WritableStream): Promise<boolean> {
  // 非互動環境（agent 經 shell 呼叫時 stdin 不是 TTY）沒有人能回答這個提示。
  // fail closed：先前這裡 return true，等於唯一的付費閘門是操作文件裡的一句話；
  // 要在這種環境派工必須明確帶 --yes。
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output });
  const answer = await rl.question(message);
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.mode === "help") {
    console.log(HELP_TEXT);
    return;
  }
  if (parsed.mode === "version") {
    console.log(getPackageVersion());
    return;
  }

  const { ticketDir, options } = parsed;
  const log = makeLogger(options.json);

  // §10 步驟 0：設定解析——DISPATCH_HOME → .env → providers 來源 → formatVersion。
  // 全部在任何 API 呼叫之前，成本為零。§24.4：明文禁止讀 cwd 的 .env，故不用
  // `import "dotenv/config"`（那會讀 cwd），改為明確指定 dispatchHome 下的路徑。
  const dispatchHome = resolveDispatchHome();
  loadDispatchEnv(dispatchHome);
  registerSecrets(SECRET_ENV_VARS.map((k) => process.env[k]));

  // v1.10 §9：--repo-root 只影響白名單邊界、.claude/agents 位置、_docs/ 拒絕判定；
  // 工單目錄仍相對 cwd 解析，不要求位於 repoRoot 內（見 resolveSpokes 呼叫處）。
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const ticketId = path.basename(path.resolve(ticketDir));

  // §10 步驟 1–2：工單解析＋允許清單存在性（loadTicket／resolveSpokes 內部 fail closed）
  const ticket = await loadTicket(ticketDir);

  // §10 步驟 3／v1.10 §24.3：providers.json 隨工具出貨、不可覆寫（方案 D）；
  // --providers 是唯一逃生口，整檔取代，一樣過 formatVersion 檢查。
  const providersPath = options.providersPath ? path.resolve(options.providersPath) : bundledProvidersPath();
  const providersSource: ProvidersSource = options.providersPath
    ? { kind: "explicit", path: providersPath, formatVersion: PROVIDERS_FORMAT_VERSION }
    : { kind: "bundled", formatVersion: PROVIDERS_FORMAT_VERSION };
  const providers = await loadProviders(providersPath);

  // §10 步驟 4–5：effort 值域、API key 齊備、models 白名單（resolveSpokes 內部）
  const spokes = await resolveSpokes(ticket, providers, repoRoot);

  // §10 步驟 6／§14 閘門一：呼叫前估算
  const estimates: SpokeEstimate[] = spokes.map((spoke) => {
    const systemPrompt = buildSystemPrompt(spoke.agentBody);
    const firstUserText = buildFirstUserText(path.resolve(ticketDir), spoke.agent, spoke.allowedReadsRelative, repoRoot);
    const charsPerToken = effectiveCharsPerToken(spoke, options);
    return {
      agent: spoke.agent,
      estimatedTokens: estimateTokens(systemPrompt, charsPerToken) + estimateTokens(firstUserText, charsPerToken),
    };
  });
  checkGateOne(estimates, options.maxTokens);

  // plan_dispatch_v2.0.md §14：允許清單總量估算，獨立於閘門一之外，只呈現不設閘門
  // （閘門一不含允許清單內容，見 gate.ts 的說明）。與 estimates 同一模式：算一次，
  // 報表與 --json plan 共用，不重複讀檔。
  const allowlistEstimates: AllowlistEstimate[] = spokes.map((spoke) => ({
    agent: spoke.agent,
    estimatedTokens: estimateAllowlistTokens(spoke.allowedReadsResolved, effectiveCharsPerToken(spoke, options)),
    fileCount: spoke.allowedReadsResolved.length,
    sequential: estimateSequentialRead(spoke.allowedReadsResolved, effectiveCharsPerToken(spoke, options)),
  }));

  const outDir = path.join(options.out, ticketId);

  // §10 步驟 6.5／v1.11 §10：輸出目錄的 gitignore 三態檢查，警告不擋執行。判定基準
  // 必須與 outDir 的解析基準一致——outDir 相對 cwd（v1.11 §24.5），故不傳 repoRoot，
  // 用 checkGitignore 的預設值（process.cwd()）。
  const gitignoreStatus = checkGitignore(outDir);

  // v1.11 §25：plan 在此刻（步驟 6 之後）已完全確定，與是否實際執行無關——dry-run／
  // cancelled／executed 三種 mode 的 --json 輸出皆含同一份 plan。
  const plan = buildJsonPlan(spokes, estimates, allowlistEstimates, options);
  const buildPayload = (
    mode: "dry-run" | "cancelled" | "executed",
    results: SpokeRunResult[],
    audits: Map<string, ReturnType<typeof auditSpoke>>,
    toolCallAudits: Map<string, ToolCallAudit>,
    exitCode: number,
  ) =>
    buildJsonPayload({
      ticketId,
      repoRoot,
      outDir,
      providersSource,
      mode,
      plan,
      gitignoreStatus,
      results,
      audits,
      toolCallAudits,
      exitCode,
    });

  // §10 步驟 7／§11：派工報表
  const report = buildReport(ticketId, spokes, estimates, allowlistEstimates, options, outDir, {
    repoRoot,
    providersSource,
    gitignoreStatus,
  });
  log.info(report);

  if (options.dryRun) {
    log.info("\n--dry-run：僅解析／驗證／估算／印報表，未呼叫任何 API。");
    if (options.json) {
      console.log(JSON.stringify(maskDeep(buildPayload("dry-run", [], new Map(), new Map(), 0))));
    }
    return;
  }

  if (!options.yes) {
    const ok = await confirm("繼續？[y/N] ", options.json ? process.stderr : process.stdout);
    if (!ok) {
      log.info(
        process.stdin.isTTY
          ? "已取消，未呼叫任何 API。"
          : "非互動環境（stdin 不是 TTY）無人可確認，已取消，未呼叫任何 API。要在此環境派工請明確加上 --yes。",
      );
      if (options.json) {
        console.log(JSON.stringify(maskDeep(buildPayload("cancelled", [], new Map(), new Map(), 0))));
      }
      return;
    }
  }

  let outDirReady = true;
  try {
    await ensureOutDir(outDir);
  } catch (err) {
    outDirReady = false;
    console.error(`落檔目錄不可寫：${outDir}`);
    console.error(maskString(String(err)));
  }

  const runLog = outDirReady ? new RunLogWriter(path.join(outDir, "run.jsonl")) : null;
  const semaphore = new Semaphore(options.concurrency);

  const onEvent = (event: RunEvent) => {
    log.info(formatEvent(event));
    runLog?.append(event as unknown as Record<string, unknown>);
  };

  // §10 步驟 8：信號量控制發起，Promise.allSettled 只負責收尾
  const settled = await Promise.allSettled(
    spokes.map(async (spoke) => {
      await semaphore.acquire();
      try {
        const adapter = createAdapterFor(spoke);
        const result = await runSpoke(spoke, adapter, ticketDir, {
          repoRoot,
          timeoutMs: options.timeoutSec * 1000,
          retries: options.retries,
          rateLimitRetries: options.rateLimitRetries,
          maxRateWaitSec: options.maxRateWaitSec,
          maxToolCalls: options.maxToolCalls,
          maxSpokeTokens: effectiveCap(spoke, options),
          maxSpokeReasoningTokens: options.maxSpokeReasoningTokens,
          maxRoundReasoningTokens: options.maxRoundReasoningTokens,
          charsPerToken: effectiveCharsPerToken(spoke, options),
          semaphore,
          onEvent,
        });
        // §13（一）：每支 spoke 完成即落檔，不等 Promise.allSettled——多 spoke 並行、
        // 其中一支慢很多時，快的那支已付費的產出不因慢的還在跑而暴露在中斷風險下。
        if (outDirReady) {
          await persistSpokeResult(outDir, result, (msg) => console.error(msg));
        }
        return result;
      } finally {
        semaphore.release();
      }
    }),
  );

  const results: SpokeRunResult[] = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    // §13：spoke 本身的錯誤已在 runSpoke 內部收斂為 status:"failed"；這裡是防禦，
    // 理論上不該發生（runSpoke 不對外拋錯）。
    const spoke = spokes[i];
    return {
      agent: spoke.agent,
      provider: spoke.provider,
      api: spoke.providerConfig.api,
      modelRequested: spoke.model,
      modelReturned: null,
      effort: spoke.effort,
      store: "unknown",
      status: "failed",
      finalText: null,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: false },
      costUsd: null,
      finishReason: null,
      finishReasonRaw: null,
      toolCalls: [],
      rateLimitHits: [],
      unknownUsageKeys: [],
      attempts: 0,
      errors: [maskString(String(s.reason))],
      requestId: null,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      latencyMs: 0,
      waitedMs: 0,
      estimatedPromptTokens: 0,
      rawRequests: [],
      rawResponses: [],
      rawErrors: [],
    } satisfies SpokeRunResult;
  });

  // §10 步驟 9：確定性稽核
  const audits = new Map(
    results.map((r) => {
      const spoke = spokes.find((sp) => sp.agent === r.agent)!;
      return [r.agent, auditSpoke(r.finalText, spoke.allowedReadsRelative)] as const;
    }),
  );
  // plan_dispatch_v2.0.md §15（一）：tool 呼叫是執行資料不是文字，獨立於 auditSpoke 之外判定。
  const toolCallAudits = new Map(
    results.map((r) => {
      const spoke = spokes.find((sp) => sp.agent === r.agent)!;
      return [r.agent, auditToolCalls(r.agent, r.toolCalls, spoke.allowedReadsRelative.length)] as const;
    }),
  );

  // §10 步驟 10：落檔 + stdout 摘要。這裡的迴圈定位已改變（v2.4 §13 規格二）：
  // per-spoke 落檔已在 spokes.map 內完成，此處是「落檔失敗的重試」，不再是
  // rejected 分支的兜底——真實 result 重寫一次是冪等的（writeFile 覆蓋）。
  if (outDirReady) {
    for (const r of results) {
      await persistSpokeResult(outDir, r, (msg) => console.error(msg));
    }
    await writeSummary(outDir, ticketId, results, audits, toolCallAudits);
    await runLog?.flush();
    log.info(`\n落檔完成：${outDir}/`);
  } else {
    // 落檔目錄不可寫時，不讓已付費的結果消失——完整結果改印到 stderr（json 模式下
    // stdout 仍須維持只有最後那個單一 JSON 物件的契約，不能把這份診斷用資料混進去）。
    log.info("\n落檔目錄不可寫，完整報告已改印於 stderr：");
    console.error(JSON.stringify(maskDeep(results), null, 2));
  }

  const allFailed = results.every((r) => r.status === "failed");
  const exitCode = allFailed ? 4 : 0;
  if (allFailed) {
    process.exitCode = exitCode;
  }

  if (options.json) {
    console.log(JSON.stringify(maskDeep(buildPayload("executed", results, audits, toolCallAudits, exitCode))));
  } else {
    log.info("\n" + buildStdoutSummary(results));
  }
}

function buildStdoutSummary(results: SpokeRunResult[]): string {
  return results
    .map(
      (r) =>
        `${r.agent}: ${r.status}  model=${r.modelReturned ?? "—"}  token=${r.usage.totalTokens}  ` +
        `cost=${r.costUsd === null ? "無價目資料" : `$${r.costUsd.toFixed(4)}`}  耗時=${r.latencyMs}ms`,
    )
    .join("\n");
}

main().catch((err) => {
  if (err instanceof DispatchError) {
    console.error(maskString(err.message));
    process.exitCode = err.exitCode;
    return;
  }
  console.error(maskString(String(err)));
  process.exitCode = 1;
});
