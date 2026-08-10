// plan_dispatch_v1.4.md §13/§14：單一 spoke 的 tool-use 迴圈、runtime 閘門二（累積 token
// 上限）、429 等待、逾時、重試、收束呼叫。狀態機見 §13。

import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  Adapter,
  BudgetTrigger,
  Conversation,
  NormalizedUsage,
  RateLimitHit,
  RawErrorEntry,
  SpokeRunResult,
  SpokeStatus,
  ToolCall,
  ToolCallLog,
} from "./types.js";
import type { ResolvedSpoke } from "./validate.js";
import { buildFinalizeUserText, buildFirstUserText, buildSystemPrompt } from "./prompt.js";
import { ALLOWLIST_REJECT_MESSAGE, checkAllowlist } from "./whitelist.js";
import { findUnknownUsageKeys, sumUsage, usageProviderKeyFor } from "./usage.js";
import { estimateCostUsd } from "./cost.js";
import { describeError, ProviderHttpError } from "./mask.js";
import { parseRetryAfter } from "./rate-limit.js";
import { RawIntegrityError } from "./raw-integrity.js";
import { classifyError } from "./error-classify.js";
import type { Semaphore } from "./semaphore.js";

const MAX_FILE_BYTES = 200 * 1024; // §13：單檔 200KB 上限，防「單輪讀入巨檔」異常
const MAX_ROUNDS = 60; // 安全上限，遠高於實務上的 --max-tool-calls，純防無窮迴圈 bug

export type RunEvent =
  | { type: "spoke_start"; agent: string; provider: string; model: string }
  | { type: "round"; agent: string; round: number; usage: NormalizedUsage; hasToolCalls: boolean }
  // plan_dispatch_v2.6.md §26 規格四／五：偵測到的「新」未知 usage 欄位（同一支 spoke
  // 內同一 key 只在首次出現時發這個事件，不逐輪重複）。
  | { type: "unknown_usage_keys"; agent: string; keys: string[]; round: number }
  | { type: "tool_call"; agent: string; path: string; allowed: boolean; reason?: string }
  | { type: "rate_limit_wait"; agent: string; seconds: number; source: string }
  // plan_fixes_v1.0.md §6：run.jsonl 先前沒有 error 欄——中斷或失敗時完全沒有線索。
  // 逐次錯誤都發（不只終局那次），message 已遮蔽（見 mask.ts describeError）。
  | { type: "round_error"; agent: string; round: number; status: number | null; message: string }
  | {
      type: "spoke_end";
      agent: string;
      status: SpokeStatus;
      latencyMs: number;
      totalTokens: number;
      // §12：estimatedPromptTokens 存在的目的是「與實際比對，校準估算公式」——若不落進
      // run.jsonl，這個比對每次都得手動翻 raw/*.request.json 重算字元數，等於白算。
      estimatedPromptTokens: number;
      costUsd: number | null; // plan_fixes_v1.0.md §4：缺價目或 usage 不可用時為 null，不是 0
      budgetTrigger?: BudgetTrigger; // §14：僅 truncated:budget 時有意義，區分觸發來源
    };

export type RunnerOptions = {
  repoRoot: string;
  timeoutMs: number;
  retries: number;
  rateLimitRetries: number;
  maxRateWaitSec: number;
  maxToolCalls: number;
  maxSpokeTokens: number;
  maxSpokeReasoningTokens: number; // §14：累積推理 token 上限
  maxRoundReasoningTokens: number | null; // §14：單輪推理 token 上限，null = 不檢查
  charsPerToken: number; // §14：須與閘門一（cli.ts 的 SpokeEstimate）用同一係數，否則兩處回報的估算會互相對不上
  semaphore: Semaphore;
  onEvent: (event: RunEvent) => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeToolCall(
  call: ToolCall,
  spoke: ResolvedSpoke,
  repoRoot: string,
): Promise<{ resultText: string; log: ToolCallLog }> {
  const requestedPath = typeof call.args.path === "string" ? call.args.path : "";
  const startedAt = Date.now();
  const check = checkAllowlist(spoke.allowSet, requestedPath, repoRoot);

  if (!check.allowed) {
    return {
      resultText: ALLOWLIST_REJECT_MESSAGE,
      log: { path: requestedPath, allowed: false, reason: check.reason, startedAt, durationMs: Date.now() - startedAt },
    };
  }

  try {
    const buf = await readFile(check.realPath);
    let content = buf.toString("utf8");
    if (buf.byteLength > MAX_FILE_BYTES) {
      content = buf.subarray(0, MAX_FILE_BYTES).toString("utf8") + "\n...(檔案超過 200KB 上限，內容已截斷)";
    }
    return {
      resultText: content,
      log: { path: requestedPath, allowed: true, startedAt, durationMs: Date.now() - startedAt },
    };
  } catch {
    return {
      resultText: ALLOWLIST_REJECT_MESSAGE,
      log: { path: requestedPath, allowed: false, reason: "not_found", startedAt, durationMs: Date.now() - startedAt },
    };
  }
}

type SendOutcome =
  | { ok: true; result: Awaited<ReturnType<Adapter["send"]>> }
  | { ok: false; kind: "failed" | "rate_limited" };

async function sendWithResilience(
  adapter: Adapter,
  conv: Conversation,
  sendOpts: { model: string; effort?: string; enableTools: boolean },
  cfg: {
    timeoutMs: number;
    retries: number; // 一般失敗重試次數（收束呼叫時呼叫端傳 0）
    rateLimitRetries: number;
    maxRateWaitSec: number;
    semaphore: Semaphore;
  },
  ctx: {
    agent: string;
    round: number; // plan_fixes_v1.0.md §6：round_error／rawErrors 要標「是第幾輪」
    errors: string[];
    rawErrors: RawErrorEntry[];
    rateLimitHits: RateLimitHit[];
    onEvent: (event: RunEvent) => void;
    addWaitedMs: (ms: number) => void;
  },
): Promise<SendOutcome> {
  let generalAttempt = 0;
  let rateLimitAttempt = 0;

  // §6：每次錯誤都記（不只終局那次）——中斷或失敗時完全沒有線索的問題，源頭是逐次錯誤
  // 從未落過檔，不是只有最後一次。message／errorBody 已在 describeError 內遮蔽。
  const recordError = (err: unknown, message: string, status: number | null, errorBody?: { message: string }) => {
    ctx.errors.push(message);
    const request = err instanceof ProviderHttpError ? err.request : undefined;
    ctx.rawErrors.push({ round: ctx.round, status, message, errorBody, request });
    ctx.onEvent({ type: "round_error", agent: ctx.agent, round: ctx.round, status, message });
  };

  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const result = await adapter.send(conv, { ...sendOpts, signal: controller.signal });
      clearTimeout(timer);
      return { ok: true, result };
    } catch (err) {
      clearTimeout(timer);

      if (err instanceof RawIntegrityError) {
        // §8：raw 完整性違反是實作缺陷，不是 API 錯誤——重試只會確定性地再次觸發同一個
        // bug（下一輪的 conv 結構仍帶著同樣的漏洞），不消耗任何網路呼叫也不可能成功。
        // 立即判定失敗，不進入一般失敗的重試計數。
        recordError(err, `raw 完整性檢查失敗（實作缺陷，不重試）：${err.message}`, null);
        return { ok: false, kind: "failed" };
      }

      const info = describeError(err);

      if (info.is429) {
        rateLimitAttempt++;
        if (rateLimitAttempt > cfg.rateLimitRetries) {
          recordError(err, `429 撞牆次數超過 --rate-limit-retries (${cfg.rateLimitRetries})`, info.status ?? 429, info.errorBody);
          return { ok: false, kind: "rate_limited" };
        }
        const { seconds, source } = parseRetryAfter(info.retryAfterHeader, info.message, rateLimitAttempt - 1);
        if (seconds > cfg.maxRateWaitSec) {
          recordError(err, `429 要求等待 ${seconds}s，超過 --max-rate-wait ${cfg.maxRateWaitSec}s`, info.status ?? 429, info.errorBody);
          return { ok: false, kind: "rate_limited" };
        }
        ctx.rateLimitHits.push({ at: Date.now(), waitSeconds: seconds, source });
        ctx.onEvent({ type: "rate_limit_wait", agent: ctx.agent, seconds, source });
        // §13：429 等待期間釋放 --concurrency 名額，結束後重新取得
        cfg.semaphore.release();
        await sleep(seconds * 1000);
        ctx.addWaitedMs(seconds * 1000);
        await cfg.semaphore.acquire();
        continue; // 不計入 retries
      }

      // §13：錯誤分類依 HTTP status code，不解析錯誤訊息字串。確定性錯誤（其他 4xx）
      // 重試必然再撞同一個錯，不消耗 --retries、直接判定失敗。
      if (classifyError(info.status) === "permanent") {
        recordError(err, info.message ?? String(err), info.status ?? null, info.errorBody);
        return { ok: false, kind: "failed" };
      }

      generalAttempt++;
      recordError(err, info.message ?? String(err), info.status ?? null, info.errorBody);
      if (generalAttempt > cfg.retries) {
        return { ok: false, kind: "failed" };
      }
      await sleep(generalAttempt === 1 ? 1000 : 4000);
    }
  }
}

export async function runSpoke(spoke: ResolvedSpoke, adapter: Adapter, ticketDir: string, options: RunnerOptions): Promise<SpokeRunResult> {
  const startedAt = Date.now();
  const systemPrompt = buildSystemPrompt(spoke.agentBody, spoke.lang);
  const firstUserText = buildFirstUserText(
    path.resolve(ticketDir),
    spoke.agent,
    spoke.allowedReadsRelative,
    options.repoRoot,
    spoke.lang,
  );
  const conv: Conversation = { systemPrompt, turns: [{ role: "user", text: firstUserText }] };

  let toolCallCount = 0;
  let cumulativeUsage: NormalizedUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: true };
  const toolCalls: ToolCallLog[] = [];
  const rateLimitHits: RateLimitHit[] = [];
  const errors: string[] = [];
  const rawRequests: unknown[] = [];
  const rawResponses: unknown[] = [];
  const rawErrors: RawErrorEntry[] = [];
  let waitedMs = 0;
  let modelReturned: string | null = null;
  let requestId: string | null = null;
  let store: "false" | "n/a" | "unknown" = "unknown";
  let finishReason: string | null = null;
  let finishReasonRaw: string | null = null;
  let finalText: string | null = null;
  let status: SpokeStatus = "succeeded";
  let budgetTrigger: BudgetTrigger | undefined;
  let finalizeMode = false;
  let attempts = 0;
  const unknownUsageKeys: string[] = [];
  const seenUnknownUsageKeys = new Set<string>();
  // plan_dispatch_v2.7.md §29 規格七之二：改用 usage.ts 的窮盡式對照表，不再用三元運算子
  // 猜——三元運算子的「其餘」分支會讓新 provider 靜默落到既有某一家的允許清單，型別檢查
  // 抓不到（同一份 commit 之外的第二個「新增 provider 忘記同步」實例，見 createAdapterFor）。
  const unknownUsageProviderKey = usageProviderKeyFor(spoke.providerConfig.api);

  const estimatedPromptTokens = Math.ceil((systemPrompt.length + firstUserText.length) / options.charsPerToken);

  options.onEvent({ type: "spoke_start", agent: spoke.agent, provider: spoke.provider, model: spoke.model });

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    attempts++;
    const outcome = await sendWithResilience(
      adapter,
      conv,
      { model: spoke.model, effort: spoke.effort, enableTools: !finalizeMode },
      {
        timeoutMs: options.timeoutMs,
        retries: finalizeMode ? 0 : options.retries, // §13：收束呼叫一般失敗不重試
        rateLimitRetries: options.rateLimitRetries,
        maxRateWaitSec: options.maxRateWaitSec,
        semaphore: options.semaphore,
      },
      {
        agent: spoke.agent,
        round,
        errors,
        rawErrors,
        rateLimitHits,
        onEvent: options.onEvent,
        addWaitedMs: (ms) => {
          waitedMs += ms;
        },
      },
    );

    if (!outcome.ok) {
      const hasContent = rawResponses.length > 0;
      if (outcome.kind === "rate_limited") {
        status = hasContent ? "truncated:rate_limit" : "failed";
      } else {
        // v1.8 §13：「終局」只指不再重試（finalizeMode 已在呼叫端把 retries 傳成 0），
        // 不指狀態標記——狀態一律依判定原則（有無已付費取得的內容），與是否為收束呼叫
        // 無關。v1.6 曾把兩者混為一談（!finalizeMode && hasContent），造成收束呼叫遇
        // 一般失敗時，即使前面幾輪已有內容，也一律回 failed，與 429 路徑的對稱處置不一致。
        status = hasContent ? "truncated:error" : "failed";
      }
      break;
    }

    const { result } = outcome;
    rawRequests.push(result.request);
    rawResponses.push(result.response);
    modelReturned = result.meta.modelReturned;
    requestId = result.meta.requestId;
    store = result.meta.store;
    finishReason = result.meta.finishReason;
    finishReasonRaw = result.meta.finishReasonRaw;
    cumulativeUsage = sumUsage(cumulativeUsage, result.usage);

    // v2.6 §26 規格六：偵測器不得有能力弄死主流程——包 try/catch，失敗時視同無新發現，
    // 靜默跳過該輪（偵測器是輔助，不是派工能否成立的條件）。
    try {
      const detected = findUnknownUsageKeys(unknownUsageProviderKey, result.usageRaw);
      const newKeys = detected.filter((k) => !seenUnknownUsageKeys.has(k));
      if (newKeys.length > 0) {
        newKeys.forEach((k) => seenUnknownUsageKeys.add(k));
        unknownUsageKeys.push(...newKeys);
        options.onEvent({ type: "unknown_usage_keys", agent: spoke.agent, keys: newKeys, round });
      }
    } catch {
      // 規格六：靜默跳過，不影響派工
    }

    const toolCallsThisRound = result.turn.role === "assistant" ? result.turn.toolCalls : [];
    options.onEvent({
      type: "round",
      agent: spoke.agent,
      round,
      usage: result.usage,
      hasToolCalls: toolCallsThisRound.length > 0,
    });

    conv.turns.push(result.turn);

    if (!result.usage.available) {
      status = "truncated:usage_unavailable";
      errors.push(`round ${round}: usage 不可用（usageMissing），保守收束`);
      finalText = result.meta.text ?? finalText;
      if (toolCallsThisRound.length === 0 || finalizeMode) break;
      finalizeMode = true;
      conv.turns.push({ role: "user", text: buildFinalizeUserText(spoke.lang) });
      continue;
    }

    if (toolCallsThisRound.length === 0) {
      finalText = result.meta.text;
      break;
    }

    if (finalizeMode) {
      // 收束呼叫理論上不帶 tool，仍收到 tool call 屬異常，防禦性丟棄不執行
      errors.push(`round ${round}: 收束呼叫仍回傳 tool call，忽略`);
      finalText = result.meta.text;
      break;
    }

    // §14：兩道推理上限，檢查順序為單輪尖峰 → 累積推理 → 累積總量。累積上限抓不到單點
    // 尖峰（實測：第四段單輪 13,615 推理 token，累積上限 400,000 遠遠碰不到），故單輪
    // 檢查優先；三者共用 truncated:budget 狀態，budgetTrigger 記來源供事後診斷。
    const roundReasoningTokens = result.usage.reasoningTokens ?? 0;
    if (options.maxRoundReasoningTokens !== null && roundReasoningTokens > options.maxRoundReasoningTokens) {
      status = "truncated:budget";
      budgetTrigger = "reasoning_round";
      finalizeMode = true;
      conv.turns.push({ role: "user", text: buildFinalizeUserText(spoke.lang) });
      continue;
    }

    const cumulativeReasoningTokens = cumulativeUsage.reasoningTokens ?? 0;
    if (cumulativeReasoningTokens > options.maxSpokeReasoningTokens) {
      status = "truncated:budget";
      budgetTrigger = "reasoning";
      finalizeMode = true;
      conv.turns.push({ role: "user", text: buildFinalizeUserText(spoke.lang) });
      continue;
    }

    if (cumulativeUsage.totalTokens >= options.maxSpokeTokens) {
      status = "truncated:budget";
      budgetTrigger = "total";
      finalizeMode = true;
      conv.turns.push({ role: "user", text: buildFinalizeUserText(spoke.lang) });
      continue;
    }

    let hitToolLimit = false;
    for (const call of toolCallsThisRound) {
      toolCallCount++;
      if (toolCallCount > options.maxToolCalls) {
        // §7：被拒的呼叫仍計入上限；觸限後不執行，直接改走收束。這次呼叫連白名單判定都
        // 沒跑到，仍記入 toolCalls[]（reason: tool_limit_exceeded）以求可觀測性——
        // 「查 run.jsonl 就能重建它到底讀了什麼、幾次被拒」不該因觸限而漏一段。
        hitToolLimit = true;
        const log: ToolCallLog = {
          path: typeof call.args.path === "string" ? call.args.path : "",
          allowed: false,
          reason: "tool_limit_exceeded",
          startedAt: Date.now(),
          durationMs: 0,
        };
        toolCalls.push(log);
        options.onEvent({ type: "tool_call", agent: spoke.agent, path: log.path, allowed: false, reason: log.reason });
        conv.turns.push({ role: "tool", callId: call.id, result: "已達 --max-tool-calls 上限，未執行" });
        continue;
      }
      const { resultText, log } = await executeToolCall(call, spoke, options.repoRoot);
      toolCalls.push(log);
      options.onEvent({ type: "tool_call", agent: spoke.agent, path: log.path, allowed: log.allowed, reason: log.reason });
      conv.turns.push({ role: "tool", callId: call.id, result: resultText });
    }

    if (hitToolLimit) {
      status = "truncated:tool_limit";
      finalizeMode = true;
      conv.turns.push({ role: "user", text: buildFinalizeUserText(spoke.lang) });
    }
  }

  const finishedAt = Date.now();
  // plan_fixes_v1.0.md §4：以請求時的型號查價（spoke.model，非 modelReturned）——價目
  // 是「配置了要付這個模型的錢」，與伺服器實際服務的模型無關。缺價目資料時回傳 null。
  const costUsd = estimateCostUsd(cumulativeUsage, spoke.providerConfig.api, spoke.providerConfig.pricing?.[spoke.model]);
  options.onEvent({
    type: "spoke_end",
    agent: spoke.agent,
    status,
    latencyMs: finishedAt - startedAt,
    totalTokens: cumulativeUsage.totalTokens,
    estimatedPromptTokens,
    costUsd,
    budgetTrigger,
  });

  return {
    agent: spoke.agent,
    provider: spoke.provider,
    api: spoke.providerConfig.api,
    modelRequested: spoke.model,
    modelReturned,
    effort: spoke.effort,
    store,
    status,
    budgetTrigger,
    finalText,
    usage: cumulativeUsage,
    costUsd,
    finishReason,
    finishReasonRaw,
    toolCalls,
    rateLimitHits,
    unknownUsageKeys,
    attempts,
    errors,
    requestId,
    startedAt,
    finishedAt,
    latencyMs: finishedAt - startedAt,
    waitedMs,
    estimatedPromptTokens,
    rawRequests,
    rawResponses,
    rawErrors,
  };
}
