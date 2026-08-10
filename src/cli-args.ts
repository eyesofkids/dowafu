// plan_dispatch_v1.4.md §9：CLI 引數解析與說明文字，抽成純函式（不含任何 I/O）以便單元
// 測試——`src/cli.ts` 是真正的進入點（bottom 有 `main().catch()` 的副作用呼叫），import
// 它來測 parseArgs 會直接跑掉整支程式；拆到這裡後 cli.ts 只是薄殼。
//
// plan_dispatch_v1.10.md §9：新增 --repo-root／--providers／--json／--help／--version，
// 並收緊兩處：多餘 positional 即中止（原靜默忽略，違反 fail closed）；無參數／--help 印
// 完整用法（原僅一行）。

import { DispatchError } from "./types.js";
import type { CliOptions } from "./report.js";
import type { RunEvent } from "./runner.js";

export const HELP_TEXT = `用法：hub-dispatch <ticket-dir> [options]

  --repo-root <dir>        白名單邊界與 .claude/agents 的根，預設 cwd
  --providers <path>       整檔取代出貨的 providers.json
  --json                   stdout 只印結果 JSON，其餘輸出改走 stderr
  --out <dir>              落檔目錄，預設 tmp/spoke/
  --concurrency <n>        同時執行的 spoke 數，預設 2
  --max-tokens <n>         呼叫前估算閘門（各 spoke 初始 prompt 總和），預設 200000
  --max-spoke-tokens <n>   單一 spoke 執行期累積上限（實際 usage），預設 400000
  --timeout <sec>          單次 API 呼叫逾時（不是整支 spoke），預設 600
  --retries <n>            單輪呼叫的重試次數（僅暫時性錯誤），預設 2
  --chars-per-token <n>    閘門一估算係數，預設 1.0（可由 providers.json 逐家覆寫）
  --max-spoke-reasoning-tokens <n>  單一 spoke 的推理 token 累積上限，預設 50000
  --max-round-reasoning-tokens <n>  單輪推理 token 上限，預設 null（不檢查）
  --rate-limit-retries <n> 429 專用重試次數，預設 5（不計入 --retries）
  --max-rate-wait <sec>    單次 429 等待上限，預設 30
  --max-tool-calls <n>     單一 spoke 的 read_file 呼叫上限，預設 30
  --dry-run                解析、驗證、估算、印報表，不呼叫 API
  --yes                    略過派工確認。非互動環境（stdin 不是 TTY）沒帶就中止
  --help, -h               印本說明後結束（exit 0）
  --version, -V            印版本號後結束（exit 0）`;

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

export function parseArgs(argv: string[]): ParsedArgs {
  // --help／--version 可出現在任何位置，且優先於其他一切解析——不要求先有 ticketDir。
  if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
  if (argv.includes("--version") || argv.includes("-V")) return { mode: "version" };

  const options = { ...DEFAULTS };
  let ticketDir: string | undefined;

  const numFlag = (name: string, apply: (n: number) => void) => {
    flagHandlers[name] = (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new DispatchError(`--${name} 需要數字，收到：${v}`, 2);
      apply(n);
    };
  };

  const flagHandlers: Record<string, (v: string) => void> = {};
  flagHandlers["out"] = (v) => (options.out = v);
  flagHandlers["repo-root"] = (v) => (options.repoRoot = v);
  flagHandlers["providers"] = (v) => (options.providersPath = v);
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
      if (!handler) throw new DispatchError(`未知選項：${arg}\n\n${HELP_TEXT}`, 2);
      const value = argv[++i];
      if (value === undefined) throw new DispatchError(`--${name} 缺少值`, 2);
      handler(value);
    } else if (ticketDir === undefined) {
      ticketDir = arg;
    } else {
      // v1.10 §9：多餘的 positional 原本被靜默忽略（`hub-dispatch a b` 只跑 a），
      // 與設計原則 2（fail closed）不一致，改為中止。
      throw new DispatchError(`多餘的引數：${arg}（工單目錄已是 "${ticketDir}"）\n\n${HELP_TEXT}`, 2);
    }
  }

  if (!ticketDir) {
    throw new DispatchError(HELP_TEXT, 2);
  }
  return { mode: "run", ticketDir, options };
}

export function formatEvent(event: RunEvent): string {
  switch (event.type) {
    case "spoke_start":
      return `[${event.agent}] 開始 → ${event.provider}/${event.model}`;
    case "round":
      return `[${event.agent}] round ${event.round} usage=${JSON.stringify(event.usage)} toolCalls=${event.hasToolCalls}`;
    case "unknown_usage_keys":
      return `[${event.agent}] ⚠ round ${event.round} 出現未知 usage 欄位：${event.keys.join(", ")}`;
    case "tool_call":
      return `[${event.agent}] read_file(${event.path}) ${event.allowed ? "允許" : `拒絕(${event.reason})`}`;
    case "rate_limit_wait":
      return `[${event.agent}] 429，等待 ${event.seconds}s（來源：${event.source}）`;
    case "round_error":
      return `[${event.agent}] ⚠ round ${event.round} 錯誤 status=${event.status ?? "—"}：${event.message}`;
    case "spoke_end":
      return (
        `[${event.agent}] 結束 status=${event.status} latency=${event.latencyMs}ms totalTokens=${event.totalTokens}` +
        ` cost=${event.costUsd === null ? "無價目資料" : `$${event.costUsd.toFixed(4)}`}` +
        (event.budgetTrigger ? ` budgetTrigger=${event.budgetTrigger}` : "")
      );
  }
}
