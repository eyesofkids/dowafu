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
import { ensureOutDir, outDirHasArtifacts, persistSpokeResult, RunLogWriter, writeSummary } from "./output.js";
import { registerSecrets, maskString, maskDeep } from "./mask.js";
import { SECRET_ENV_VARS } from "./secret-env.js";
import { resolveDispatchHome, loadDispatchEnv } from "./dispatch-home.js";
import { buildDoctorReport, type DoctorProvidersResult } from "./doctor.js";
import { bundledProvidersPath, getPackageVersion, getCommandName } from "./pkg-info.js";
import { checkGitignore } from "./gitignore-check.js";
import { buildJsonPayload, buildJsonPlan } from "./json-output.js";
import { parseArgs, formatEvent, resolveLang, resolveFallbackLang, buildStdoutSummary } from "./cli-args.js";
import { m } from "./messages.js";
import type { SpokeRunResult } from "./types.js";

function createAdapterFor(spoke: ResolvedSpoke): Adapter {
  const apiKey = process.env[`${spoke.provider.toUpperCase()}_API_KEY`];
  if (!apiKey) {
    // resolveSpokes 已檢查過，此處為型別窄化防禦。用 spoke.lang 而非 langRaw／options.lang——
    // 它是 ResolvedSpoke 上已經過 resolveLang 判定的權威值，與 run-level lang 同一個來源。
    throw new DispatchError(m(spoke.lang, "apiKeyMissing", spoke.provider), 2);
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
        lang: spoke.lang,
      });
    case "gemini-native":
      return createGeminiAdapter({ apiKey, baseURL: spoke.providerConfig.baseURL, lang: spoke.lang });
    case "anthropic-messages":
      return createAnthropicAdapter({
        baseURL: spoke.providerConfig.baseURL,
        apiKey,
        reasoning: spoke.providerConfig.reasoning,
        lang: spoke.lang,
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
  // plan_i18n_v1.3.md §三：DISPATCH_HOME → .env → secrets 全部搬到 parseArgs 之前，
  // 因為這段現在跑在 --help 之前，任何會拋的東西都會擋住求助路徑——resolveDispatchHome／
  // loadDispatchEnv 內部已各自降級失敗為「沒有設定檔」。§24.4：明文禁止讀 cwd 的 .env，
  // 故不用 `import "dotenv/config"`（那會讀 cwd），改為明確指定 dispatchHome 下的路徑。
  const dispatchHome = resolveDispatchHome();
  if (dispatchHome !== null) loadDispatchEnv(dispatchHome);
  registerSecrets(SECRET_ENV_VARS.map((k) => process.env[k]));

  // plan_i18n_impl_tickets T3：parseArgs 自己的解析期錯誤、以及 --help 本身的輸出，都發生在
  // resolveLang 判定出權威語言之前——這裡只能用「DISPATCH_LANG 有效就用它，否則內建預設 en」
  // 這個不會拋例外的簡化判定（resolveFallbackLang，見 cli-args.ts）。--lang 旗標的值在這個
  // 時間點還沒被驗證，不查它（v1.3 §二之2 #5／#6：help／version 的語言不受 --lang 影響）。
  const messageLang = resolveFallbackLang(process.env.DISPATCH_LANG);

  const parsed = parseArgs(process.argv.slice(2), messageLang);
  if (parsed.mode === "help") {
    console.log(m(messageLang, "helpText", getCommandName()));
    return;
  }
  if (parsed.mode === "version") {
    console.log(getPackageVersion());
    return;
  }
  if (parsed.mode === "doctor") {
    // 工單 W1 §一之2：語言走 messageLang（resolveFallbackLang），不受 --lang 影響——
    // --doctor 可能正是拿來診斷 --lang／DISPATCH_LANG 本身壞掉的工具。
    // §一之6：型號白名單走既有的 loadProviders／bundledProvidersPath，載入失敗印失敗原因、
    // 不中止（doctor 本身 exit 一律 0，見下方 buildDoctorReport 的呼叫沒有任何 throw 路徑）。
    let providersResult: DoctorProvidersResult;
    try {
      const providers = await loadProviders(bundledProvidersPath(), messageLang);
      providersResult = { ok: true, providers };
    } catch (err) {
      const reason = err instanceof DispatchError ? err.message : maskString(String(err));
      providersResult = { ok: false, reason };
    }
    console.log(buildDoctorReport(messageLang, getCommandName(), providersResult));
    return;
  }

  const { ticketDir, options } = parsed;
  const log = makeLogger(options.json);

  // plan_i18n_v1.3.md §二：--lang > DISPATCH_LANG > 內建預設，含九項組合判定
  // （fail closed，無效值 exit 2）。help／version 已在上面短路，不會走到這裡。
  //
  // T1 驗收帶出的第一條（T3 執行）：語言的權威來源只有這行的回傳值。CLI 層訊息一律用
  // 這個 lang，不得讀 options.langRaw——後者是未經 parseLang 驗證的原始字串，可能是
  // undefined 或未正規化的 "ZH-TW"，誤用會靜默走中文分支且 typecheck 不會紅。
  const lang = resolveLang(options.langRaw, process.env.DISPATCH_LANG);

  // v1.10 §9：--repo-root 只影響白名單邊界、.claude/agents 位置、_docs/ 拒絕判定；
  // 工單目錄仍相對 cwd 解析，不要求位於 repoRoot 內（見 resolveSpokes 呼叫處）。
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const ticketId = path.basename(path.resolve(ticketDir));

  // §10 步驟 1–2：工單解析＋允許清單存在性（loadTicket／resolveSpokes 內部 fail closed）
  const ticket = await loadTicket(ticketDir, lang);

  // §10 步驟 3／v1.10 §24.3：providers.json 隨工具出貨、不可覆寫（方案 D）；
  // --providers 是唯一逃生口，整檔取代，一樣過 formatVersion 檢查。
  const providersPath = options.providersPath ? path.resolve(options.providersPath) : bundledProvidersPath();
  const providersSource: ProvidersSource = options.providersPath
    ? { kind: "explicit", path: providersPath, formatVersion: PROVIDERS_FORMAT_VERSION }
    : { kind: "bundled", formatVersion: PROVIDERS_FORMAT_VERSION };
  const providers = await loadProviders(providersPath, lang);

  // §10 步驟 4–5：effort 值域、API key 齊備、models 白名單（resolveSpokes 內部）
  const spokes = await resolveSpokes(ticket, providers, repoRoot, lang);

  // §10 步驟 6／§14 閘門一：呼叫前估算
  const estimates: SpokeEstimate[] = spokes.map((spoke) => {
    const systemPrompt = buildSystemPrompt(spoke.agentBody, spoke.lang);
    const firstUserText = buildFirstUserText(
      path.resolve(ticketDir),
      spoke.agent,
      spoke.allowedReadsRelative,
      repoRoot,
      spoke.lang,
    );
    const charsPerToken = effectiveCharsPerToken(spoke, options);
    return {
      agent: spoke.agent,
      estimatedTokens: estimateTokens(systemPrompt, charsPerToken) + estimateTokens(firstUserText, charsPerToken),
    };
  });
  checkGateOne(estimates, options.maxTokens, lang);

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
  const report = buildReport(
    ticketId,
    spokes,
    estimates,
    allowlistEstimates,
    options,
    outDir,
    {
      repoRoot,
      providersSource,
      gitignoreStatus,
      reviewTextChars: ticket.shared.reviewText.length,
      strayHeadings: ticket.shared.strayHeadings,
    },
    lang,
  );
  log.info(report);

  // 護欄的預告：乾跑不受影響（它不寫任何東西），但先講，免得實跑才發現被擋。
  const outDirDirty = await outDirHasArtifacts(outDir);

  if (options.dryRun) {
    if (outDirDirty) log.info("\n" + m(lang, "outDirNotEmptyDryRunWarning", outDir));
    log.info("\n" + m(lang, "dryRunNotice"));
    if (options.json) {
      console.log(JSON.stringify(maskDeep(buildPayload("dry-run", [], new Map(), new Map(), 0))));
    }
    return;
  }

  // 擋在 confirm 之前：不要先問「要不要花錢」再中止。exitCode 5 是「派工前被守則擋下、
  // 未花任何錢」，與 3（成本閘門超限）分開，才分得出是哪一種擋。
  // **刻意不提供 --overwrite 之類的旗標**：有旗標，「加上去」就會變成最便宜的滿足方式，
  // 那正是 --yes 已經示範過的路。要覆蓋，由使用者自己清掉目錄。
  if (outDirDirty) {
    throw new DispatchError(m(lang, "outDirNotEmptyAbort", outDir), 5);
  }

  if (!options.yes) {
    const ok = await confirm(m(lang, "confirmPrompt"), options.json ? process.stderr : process.stdout);
    if (!ok) {
      log.info(process.stdin.isTTY ? m(lang, "cancelledInteractive") : m(lang, "cancelledNonInteractive"));
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
    console.error(m(lang, "outDirNotWritable", outDir));
    console.error(maskString(String(err)));
  }

  const runLog = outDirReady ? new RunLogWriter(path.join(outDir, "run.jsonl"), lang) : null;
  const semaphore = new Semaphore(options.concurrency);

  const onEvent = (event: RunEvent) => {
    log.info(formatEvent(event, lang));
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
          await persistSpokeResult(outDir, result, (msg) => console.error(msg), lang);
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
  const audits = new Map(results.map((r) => [r.agent, auditSpoke(r.finalText)] as const));
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
      await persistSpokeResult(outDir, r, (msg) => console.error(msg), lang);
    }
    await writeSummary(outDir, ticketId, results, audits, toolCallAudits, lang);
    await runLog?.flush();
    log.info("\n" + m(lang, "outDirWritten", outDir));
  } else {
    // 落檔目錄不可寫時，不讓已付費的結果消失——完整結果改印到 stderr（json 模式下
    // stdout 仍須維持只有最後那個單一 JSON 物件的契約，不能把這份診斷用資料混進去）。
    log.info("\n" + m(lang, "outDirFallbackStderr"));
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
    log.info("\n" + buildStdoutSummary(results, lang));
  }
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
