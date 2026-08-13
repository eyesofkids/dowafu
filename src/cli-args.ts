// plan_dispatch_v1.4.md §9：CLI 引數解析與說明文字，抽成純函式（不含任何 I/O）以便單元
// 測試——`src/cli.ts` 是真正的進入點（bottom 有 `main().catch()` 的副作用呼叫），import
// 它來測 parseArgs 會直接跑掉整支程式；拆到這裡後 cli.ts 只是薄殼。
//
// plan_dispatch_v1.10.md §9：新增 --repo-root／--providers／--json／--help／--version，
// 並收緊兩處：多餘 positional 即中止（原靜默忽略，違反 fail closed）；無參數／--help 印
// 完整用法（原僅一行）。

import { DispatchError } from "./types.js";
import { getCommandName } from "./pkg-info.js";
import { m } from "./messages.js";
import type { CliOptions } from "./report.js";
import type { RunEvent } from "./runner.js";
import type { Lang, SpokeRunResult } from "./types.js";

const DEFAULTS: CliOptions = {
  out: "tmp/spoke",
  concurrency: 2,
  maxTokens: 200_000,
  maxSpokeTokens: 400_000,
  // plan_fixes_v1.0.md §2b：實測單次 API 呼叫曾達 559s（token 只多 18%、輪數相同，
  // 耗時卻是 2.7 倍，判定為對方伺服器負載、不可歸因），300 太容易誤砍未卡住的呼叫。
  timeoutSec: 600,
  // §14：重試是輪級不是 spoke 級（sendWithResilience 收的是當前 conversation），成本
  // 增量遠小於 v1.6 誤述的「1+N 次全額計費」；多輪長執行窗口中的網路波動是真實風險，
  // 故預設由 0 改 2（v1.7 裁示）。
  retries: 2,
  rateLimitRetries: 5,
  maxRateWaitSec: 30,
  maxToolCalls: 30,
  charsPerToken: 1.0,
  maxSpokeReasoningTokens: 50_000,
  maxRoundReasoningTokens: null,
  json: false,
  dryRun: false,
  yes: false,
};

export type ParsedArgs =
  | { mode: "help" }
  | { mode: "version" }
  | { mode: "run"; ticketDir: string; options: CliOptions };

// plan_i18n_v1.3.md §二之1：--lang 與 DISPATCH_LANG 走同一個判定函式，接受 en／zh-tw／zh，
// 大小寫不敏感、trim。不共用的話會出現「同一個值放旗標有效、放環境變數無效」這種依媒介
// 分裂的邊界，是最難查的那種不一致。
export function parseLang(value: string): Lang | null {
  const v = value.trim().toLowerCase();
  if (v === "en") return "en";
  if (v === "zh-tw" || v === "zh") return "zh";
  return null;
}

// plan_i18n_impl_tickets T3：resolveLang 之前，還有一段訊息需要語言——parseArgs 自己的
// 解析期錯誤、以及 resolveLang 判定失敗時它自己要拋的那兩則訊息。這段時序裡還沒有
// 「權威語言」可用（--lang 可能就是壞的那個值，資格未定；resolveLang 本身還沒跑完，
// 不能拿它自己會拋例外的回傳值來決定拋例外訊息用什麼語言）。
//
// v1.2 §1.3／§3.2：這類訊息一律走「DISPATCH_LANG 有效就用它，否則用內建預設 en」——
// 不查 --lang（它在這個時間點的有效性正是問題本身），也不會拋例外。cli.ts 在
// registerSecrets／loadDispatchEnv 之後、parseArgs 之前算好這個值，一併傳給 parseArgs
// 與用於 --help 本身的輸出；resolveLang 內部對它自己的兩則錯誤訊息也重用同一函式。
export function resolveFallbackLang(envLangRaw: string | undefined): Lang {
  const trimmed = (envLangRaw ?? "").trim();
  if (!trimmed) return "en";
  return parseLang(trimmed) ?? "en";
}

// plan_i18n_v1.3.md §二之2：--lang 與 DISPATCH_LANG 的完整組合表（九項）。
// 呼叫時機：parseArgs 之後、help／version 短路之後——在此之前不得驗證語言。
export function resolveLang(cliLangRaw: string | undefined, envLangRaw: string | undefined): Lang {
  const envTrimmed = (envLangRaw ?? "").trim();
  const envIsSet = envTrimmed.length > 0; // #7：空字串／全空白視為「未設定」，不是無效
  const envParsed = envIsSet ? parseLang(envTrimmed) : null;
  const msgLang = resolveFallbackLang(envLangRaw);

  if (cliLangRaw !== undefined) {
    const cliParsed = parseLang(cliLangRaw);
    if (cliParsed !== null) return cliParsed; // #1：旗標有效，不驗 DISPATCH_LANG
    // #4：旗標無效——一併指出 env 是否也無效，避免使用者修好旗標後才撞到 env 又是壞的。
    const envNote =
      envIsSet && envParsed === null ? m(msgLang, "invalidEnvAlsoNote", envLangRaw) : "";
    throw new DispatchError(
      m(
        msgLang,
        "invalidLangFlag",
        cliLangRaw,
        m(msgLang, "availableValuesSuffix", m(msgLang, "availableLangValues")),
        envNote,
      ),
      2,
    );
  }

  if (!envIsSet) return "en"; // #7：未設定 → 內建預設
  if (envParsed !== null) return envParsed; // #2
  // #3：DISPATCH_LANG 無效且沒有有效 --lang——訊息須指名是環境變數，不是旗標。
  throw new DispatchError(
    m(msgLang, "invalidEnvLang", envLangRaw, m(msgLang, "availableValuesSuffix", m(msgLang, "availableLangValues"))),
    2,
  );
}

// plan_i18n_impl_tickets T3：lang 是「訊息語言」，即 resolveFallbackLang 算出的那個值
// （見上方說明）——parseArgs 這個階段權威語言尚未確定，不是 run-level lang。
export function parseArgs(argv: string[], lang: Lang): ParsedArgs {
  const helpText = m(lang, "helpText", getCommandName());

  // --help／--version 可出現在任何位置，且優先於其他一切解析——不要求先有 ticketDir。
  if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
  if (argv.includes("--version") || argv.includes("-V")) return { mode: "version" };

  const options = { ...DEFAULTS };
  let ticketDir: string | undefined;

  const numFlag = (name: string, apply: (n: number) => void) => {
    flagHandlers[name] = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new DispatchError(m(lang, "numberFlagInvalid", name, v), 2);
      apply(n);
    };
  };

  const flagHandlers: Record<string, (v: string) => void> = {};
  flagHandlers["out"] = (v) => (options.out = v);
  flagHandlers["repo-root"] = (v) => (options.repoRoot = v);
  flagHandlers["providers"] = (v) => (options.providersPath = v);
  // 這裡只存原始字串，不驗證格式——格式與 DISPATCH_LANG 的組合判定需要 process.env，
  // parseArgs 是純函式不碰它，交給 cli.ts 呼叫 resolveLang（見下）。重複帶 --lang 時
  // 最後一次覆蓋前一次，與其他旗標一致（v1.3 §二之2 #8）。
  flagHandlers["lang"] = (v) => (options.langRaw = v);
  numFlag("concurrency", (n) => (options.concurrency = n));
  numFlag("max-tokens", (n) => (options.maxTokens = n));
  numFlag("max-spoke-tokens", (n) => (options.maxSpokeTokens = n));
  numFlag("timeout", (n) => (options.timeoutSec = n));
  numFlag("retries", (n) => (options.retries = n));
  numFlag("rate-limit-retries", (n) => (options.rateLimitRetries = n));
  numFlag("max-rate-wait", (n) => (options.maxRateWaitSec = n));
  numFlag("max-tool-calls", (n) => (options.maxToolCalls = n));
  numFlag("chars-per-token", (n) => (options.charsPerToken = n));
  numFlag("max-spoke-reasoning-tokens", (n) => (options.maxSpokeReasoningTokens = n));
  numFlag("max-round-reasoning-tokens", (n) => (options.maxRoundReasoningTokens = n));

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--yes") {
      options.yes = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const handler = flagHandlers[name];
      if (!handler) throw new DispatchError(m(lang, "unknownOption", arg, helpText), 2);
      const value = argv[++i];
      if (value === undefined) {
        // v1.3 §二之2 #9：--lang 缺值時沿用既有的「缺少值」措辭，額外列出可用值。
        const suffix =
          name === "lang" ? m(lang, "availableValuesSuffix", m(lang, "availableLangValues")) : "";
        throw new DispatchError(m(lang, "missingFlagValue", name, suffix), 2);
      }
      handler(value);
    } else if (ticketDir === undefined) {
      ticketDir = arg;
    } else {
      // v1.10 §9：多餘的 positional 原本被靜默忽略（`hub-dispatch a b` 只跑 a），
      // 與設計原則 2（fail closed）不一致，改為中止。
      throw new DispatchError(m(lang, "tooManyArgs", arg, ticketDir, helpText), 2);
    }
  }

  if (!ticketDir) {
    throw new DispatchError(helpText, 2);
  }
  return { mode: "run", ticketDir, options };
}

// plan_i18n_impl_tickets T3：跟 run-level lang，不是 env lang——這是執行中的即時輸出，
// 此時 resolveLang 早已成功、cli.ts 手上有權威值，直接傳進來即可，不必再猜語言。
export function formatEvent(event: RunEvent, lang: Lang): string {
  switch (event.type) {
    case "spoke_start":
      return m(lang, "eventSpokeStart", event.agent, event.provider, event.model);
    case "round":
      // 此則純 ASCII（round／usage／toolCalls 皆非中文），兩語言逐字相同，不必經 messages.ts。
      return `[${event.agent}] round ${event.round} usage=${JSON.stringify(event.usage)} toolCalls=${event.hasToolCalls}`;
    case "unknown_usage_keys":
      return m(lang, "eventUnknownUsageKeys", event.agent, event.round, event.keys.join(", "));
    case "tool_call":
      return m(lang, "eventToolCall", event.agent, event.path, event.allowed, event.reason);
    case "rate_limit_wait":
      return m(lang, "eventRateLimitWait", event.agent, event.seconds, event.source);
    case "round_error":
      return m(lang, "eventRoundError", event.agent, event.round, String(event.status ?? "—"), event.message);
    case "spoke_end": {
      const costLabel = event.costUsd === null ? m(lang, "noPricingData") : `$${event.costUsd.toFixed(4)}`;
      const budgetSuffix = event.budgetTrigger ? ` budgetTrigger=${event.budgetTrigger}` : "";
      return m(
        lang,
        "eventSpokeEnd",
        event.agent,
        event.status,
        event.latencyMs,
        event.totalTokens,
        costLabel,
        budgetSuffix,
      );
    }
  }
}

// plan_i18n_impl_tickets T3b：moved out of cli.ts（原本是該檔的私有函式）。cli.ts 底部有
// `main().catch()` 的無條件呼叫，import 它會直接跑掉整支程式（見檔頭說明）——這支函式本身
// 純函式、不含 I/O，搬來這裡才有安全的方式可以單元測試，不必 spawn 子行程。
export function buildStdoutSummary(results: SpokeRunResult[], lang: Lang): string {
  return results
    .map((r) =>
      m(
        lang,
        "stdoutSummaryLine",
        r.agent,
        r.status,
        r.modelReturned ?? "—",
        r.usage.totalTokens,
        r.costUsd === null ? m(lang, "noPricingData") : `$${r.costUsd.toFixed(4)}`,
        r.latencyMs,
      ),
    )
    .join("\n");
}
