import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, parseLang, resolveLang, resolveFallbackLang, formatEvent, buildStdoutSummary } from "./cli-args.js";
import { DEFAULT_MAX_TOOL_CALLS } from "./cost.js";
import { DispatchError } from "./types.js";
import { m } from "./messages.js";
import { getCommandName } from "./pkg-info.js";
import type { RunEvent } from "./runner.js";
import type { SpokeRunResult } from "./types.js";

// plan_dispatch_v1.10.md §9／§20：--repo-root／--providers／--json／--help／--version，
// 以及兩處收緊（多餘 positional 即中止；無參數印完整用法）。
//
// plan_i18n_impl_tickets T3／v1.2 §5.5：訊息斷言不再比對寫死的中文子字串——parseArgs 現在
// 依 lang 產出不同語言的文字，斷言改成呼叫 m(lang, key, ...args) 重建期望值再比對，這樣
// 斷言驗的是「用了正確的 key 與參數」，不會因為某天改了英文措辭就連帶要求中文措辭也對應改。

const CMD = getCommandName();
const HELP_EN = m("en", "helpText", CMD);

test("parseArgs：基本情況——只有 ticketDir，其餘走預設值", () => {
  const parsed = parseArgs(["tmp/dispatch/t1"], "en");
  assert.equal(parsed.mode, "run");
  if (parsed.mode !== "run") throw new Error("unreachable");
  assert.equal(parsed.ticketDir, "tmp/dispatch/t1");
  assert.equal(parsed.options.json, false);
  assert.equal(parsed.options.repoRoot, undefined);
  assert.equal(parsed.options.retries, 2); // v1.7 裁示的預設值，非本輪變更但一併確認未被本輪改動打壞
});

// 票 cost-cap §D：30 → 20，實測從未超過 15 輪（facts_output_cap.md §四）。--max-tool-calls
// 明確覆寫時（見既有的 numFlag 測試）仍照舊生效，這裡只鎖預設值本身。
test("parseArgs：--max-tool-calls 預設值為 20（票 cost-cap §D，30 → 20）", () => {
  const parsed = parseArgs(["tmp/dispatch/t1"], "en");
  if (parsed.mode !== "run") throw new Error("unreachable");
  assert.equal(parsed.options.maxToolCalls, 20);
  assert.equal(DEFAULT_MAX_TOOL_CALLS, 20);
});

test("parseArgs：--max-tool-calls 明確帶上去仍可覆寫預設值（硬上限不得寫死）", () => {
  const parsed = parseArgs(["tmp/dispatch/t1", "--max-tool-calls", "30"], "en");
  if (parsed.mode !== "run") throw new Error("unreachable");
  assert.equal(parsed.options.maxToolCalls, 30);
});

test("parseArgs：--repo-root 正確寫入 options，--providers 已退場", () => {
  const parsed = parseArgs(["t1", "--repo-root", "/some/project"], "en");
  assert.equal(parsed.mode, "run");
  if (parsed.mode !== "run") throw new Error("unreachable");
  assert.equal(parsed.options.repoRoot, "/some/project");
  assert.throws(() => parseArgs(["t1", "--providers", "/custom/providers.json"], "en"), DispatchError);
});

test("parseArgs：--json 旗標", () => {
  const parsed = parseArgs(["t1", "--json"], "en");
  assert.equal(parsed.mode, "run");
  if (parsed.mode !== "run") throw new Error("unreachable");
  assert.equal(parsed.options.json, true);
});

test("parseArgs：--help 不需要 ticketDir，回傳 mode:help", () => {
  assert.deepEqual(parseArgs(["--help"], "en"), { mode: "help" });
  assert.deepEqual(parseArgs(["-h"], "en"), { mode: "help" });
});

test("parseArgs：--help 出現在任何位置皆生效，優先於其他解析（不因後面有非法旗標而先報錯）", () => {
  assert.deepEqual(parseArgs(["t1", "--totally-unknown-flag", "--help"], "en"), { mode: "help" });
});

test("parseArgs：--version／-V 不需要 ticketDir，回傳 mode:version", () => {
  assert.deepEqual(parseArgs(["--version"], "en"), { mode: "version" });
  assert.deepEqual(parseArgs(["-V"], "en"), { mode: "version" });
});

// 工單 W1（fix_batch_4）§一之1／§一之7：--doctor 是第三個 mode，不接受也不需要 ticket-dir；
// 與 --help 同時給時 --help 優先（help > version > doctor）。

test("parseArgs：--doctor 不需要 ticketDir，回傳 mode:doctor", () => {
  assert.equal(parseArgs(["--doctor"], "en").mode, "doctor");
});

test("parseArgs：--doctor 與已知旗標（如 --lang）同時給仍生效，不因此中止", () => {
  assert.equal(parseArgs(["--doctor", "--lang", "zh-tw"], "en").mode, "doctor");
});

// A（gaps #1）：doctor 要帶著 options 回來。旗標迴圈本來就解析了 --db，先前只是沒回傳，
// 於是 `--doctor --db <路徑>` 靜默對著預設 DB 回答——這條鎖住「它真的帶回來了」。
test("parseArgs：--doctor 帶回 options，--db 不會被丟掉", () => {
  const parsed = parseArgs(["--doctor", "--db", "/tmp/other.db"], "en");
  assert.equal(parsed.mode, "doctor");
  if (parsed.mode !== "doctor") throw new Error("unreachable");
  assert.equal(parsed.options.dbPath, "/tmp/other.db");
});

test("parseArgs：serve 是常駐 daemon 子命令，仍可帶既有 --db", () => {
  const parsed = parseArgs(["serve", "--db", "/tmp/dowafu.db"], "en");
  assert.equal(parsed.mode, "serve");
  if (parsed.mode !== "serve") throw new Error("unreachable");
  assert.equal(parsed.options.dbPath, "/tmp/dowafu.db");
  assert.equal(parsed.stop, false);
});

test("parseArgs：serve --stop 保持在 serve 介面，--yes 可作為明確強制旗標", () => {
  const parsed = parseArgs(["serve", "--stop", "--yes"], "en");
  assert.equal(parsed.mode, "serve");
  if (parsed.mode !== "serve") throw new Error("unreachable");
  assert.equal(parsed.stop, true);
  assert.equal(parsed.restart, false);
  assert.equal(parsed.options.yes, true);
});

test("parseArgs：serve --restart 是獨立操作，不能與 --stop 混用或脫離 serve", () => {
  const parsed = parseArgs(["serve", "--restart", "--yes"], "en");
  assert.equal(parsed.mode, "serve");
  if (parsed.mode !== "serve") throw new Error("unreachable");
  assert.equal(parsed.stop, false);
  assert.equal(parsed.restart, true);
  assert.equal(parsed.options.yes, true);
  assert.throws(() => parseArgs(["serve", "--stop", "--restart"], "en"), DispatchError);
  assert.throws(() => parseArgs(["--restart"], "en"), DispatchError);
});

test("parseArgs：--stop 沒有 serve 時 fail closed", () => {
  assert.throws(() => parseArgs(["--stop"], "en"), DispatchError);
  assert.throws(() => parseArgs(["--doctor", "--stop"], "en"), DispatchError);
});

test("parseArgs：serve 的 --http-port 有預設值，且可覆寫", () => {
  const withDefault = parseArgs(["serve"], "en");
  assert.equal(withDefault.mode, "serve");
  if (withDefault.mode !== "serve") throw new Error("unreachable");
  assert.equal(withDefault.options.httpPort, 7391);

  const overridden = parseArgs(["serve", "--http-port", "9000"], "en");
  if (overridden.mode !== "serve") throw new Error("unreachable");
  assert.equal(overridden.options.httpPort, 9000);
});

test("parseArgs：--http-port 非數字時 fail closed", () => {
  assert.throws(() => parseArgs(["serve", "--http-port", "not-a-number"], "en"), DispatchError);
});

test("parseArgs：mcp 是 stdio 子命令，仍可帶既有 --db", () => {
  const parsed = parseArgs(["mcp", "--db", "/tmp/dowafu.db"], "en");
  assert.equal(parsed.mode, "mcp");
  if (parsed.mode !== "mcp") throw new Error("unreachable");
  assert.equal(parsed.options.dbPath, "/tmp/dowafu.db");
});

test("parseArgs：daemon 的內部 job-id 只登錄，不改一般 ticket positional", () => {
  const parsed = parseArgs(["ticket-a", "--job-id", "job-a"], "en");
  assert.equal(parsed.mode, "run");
  if (parsed.mode !== "run") throw new Error("unreachable");
  assert.equal(parsed.ticketDir, "ticket-a");
  assert.equal(parsed.options.jobId, "job-a");
});

test("parseArgs：--doctor 與 --help 同時給，--help 優先", () => {
  assert.deepEqual(parseArgs(["--doctor", "--help"], "en"), { mode: "help" });
  assert.deepEqual(parseArgs(["--help", "--doctor"], "en"), { mode: "help" });
});

test("parseArgs：--doctor 與 --version 同時給，--version 優先", () => {
  assert.deepEqual(parseArgs(["--doctor", "--version"], "en"), { mode: "version" });
});

test("parseArgs：--doctor 帶了 ticket-dir 這種多餘的 positional → 中止，走既有的 tooManyArgs", () => {
  assert.throws(
    () => parseArgs(["some-ticket-dir", "--doctor"], "en"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.exitCode, 2);
      assert.equal(err.message, m("en", "tooManyArgs", "some-ticket-dir", "--doctor", HELP_EN));
      return true;
    },
  );
});

test("parseArgs：無任何引數 → 拋 DispatchError，訊息為完整用法，exit 2", () => {
  assert.throws(
    () => parseArgs([], "en"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.exitCode, 2);
      assert.equal(err.message, HELP_EN);
      return true;
    },
  );
});

test("parseArgs：無任何引數（zh）→ 完整用法改用中文，證明同一個 key 依 lang 換文字", () => {
  assert.throws(
    () => parseArgs([], "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, m("zh", "helpText", CMD));
      assert.notEqual(err.message, HELP_EN);
      return true;
    },
  );
});

test("parseArgs：第二個 positional 即中止（v1.10 §9，原本靜默忽略違反 fail closed）", () => {
  assert.throws(
    () => parseArgs(["ticket-a", "ticket-b"], "en"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.exitCode, 2);
      assert.equal(err.message, m("en", "tooManyArgs", "ticket-b", "ticket-a", HELP_EN));
      return true;
    },
  );
});

test("parseArgs：未知旗標仍中止（既有行為，確認拆分後未壞）", () => {
  assert.throws(
    () => parseArgs(["t1", "--not-a-real-flag", "x"], "en"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, m("en", "unknownOption", "--not-a-real-flag", HELP_EN));
      return true;
    },
  );
});

test("parseArgs：數字旗標收到非數字 → 中止", () => {
  assert.throws(
    () => parseArgs(["t1", "--concurrency", "abc"], "en"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, m("en", "numberFlagInvalid", "concurrency", "abc"));
      return true;
    },
  );
});

// plan_i18n_v1.3.md §二：--lang 只在此登錄為原始字串，不驗證格式；格式與 DISPATCH_LANG
// 的組合判定見 resolveLang（下方），因為那需要 process.env，parseArgs 是純函式不碰它。
//
// T1 驗收帶出的第一條（T3 執行）：欄位由 lang 改名 langRaw，見 report.ts 的 CliOptions。

test("parseArgs：--lang 登錄為原始字串，寫入 options.langRaw", () => {
  const parsed = parseArgs(["t1", "--lang", "en"], "en");
  assert.equal(parsed.mode, "run");
  if (parsed.mode !== "run") throw new Error("unreachable");
  assert.equal(parsed.options.langRaw, "en");
});

// v1.3 §二之2 #8：--lang 重複，最後一個值判定（與其他旗標一致）。
test("parseArgs：--lang 重複帶多次，取最後一個原始值", () => {
  const parsed = parseArgs(["t1", "--lang", "en", "--lang", "bogus"], "en");
  assert.equal(parsed.mode, "run");
  if (parsed.mode !== "run") throw new Error("unreachable");
  assert.equal(parsed.options.langRaw, "bogus");
});

// v1.3 §二之2 #9：--lang 缺值時沿用既有的「缺少值」措辭，額外列出可用值。
test("parseArgs：--lang 缺值（argv 末尾）→ 中止，訊息列出可用值", () => {
  assert.throws(
    () => parseArgs(["t1", "--lang"], "en"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.exitCode, 2);
      assert.equal(
        err.message,
        m("en", "missingFlagValue", "lang", m("en", "availableValuesSuffix", m("en", "availableLangValues"))),
      );
      return true;
    },
  );
});

// v1.3 §二之2 #5／#6：--help／--version 優先於一切解析，即使 --lang 的值本身無效，
// 也不會在 parseArgs 階段被驗證（驗證發生在後面的 resolveLang，help/version 根本不會走到那裡）。
test("parseArgs：--lang 值無效但同時帶 --help，仍照印 help、不中止（#5）", () => {
  assert.deepEqual(parseArgs(["t1", "--lang", "totally-bogus", "--help"], "en"), { mode: "help" });
});

test("parseArgs：--lang 值無效但同時帶 --version，仍照印 version、不中止（#6）", () => {
  assert.deepEqual(parseArgs(["t1", "--lang", "totally-bogus", "--version"], "en"), { mode: "version" });
});

// plan_i18n_v1.3.md §二之1：parseLang 是 --lang 與 DISPATCH_LANG 共用的判定函式。

test("parseLang：接受 en／zh-tw／zh，大小寫不敏感、trim", () => {
  assert.equal(parseLang("en"), "en");
  assert.equal(parseLang("  EN  "), "en");
  assert.equal(parseLang("zh-tw"), "zh");
  assert.equal(parseLang("ZH-TW"), "zh");
  assert.equal(parseLang("zh"), "zh");
});

test("parseLang：無效值回傳 null", () => {
  assert.equal(parseLang("fr"), null);
  assert.equal(parseLang(""), null);
});

// plan_i18n_impl_tickets T3：resolveFallbackLang 是 parseArgs 自己的解析期訊息、以及
// resolveLang 判定失敗時的訊息語言來源——不查 --lang（它此時可能就是壞的那個值），
// 不拋例外，只有「DISPATCH_LANG 有效就用它，否則內建預設 en」兩種結果。

test("resolveFallbackLang：DISPATCH_LANG 有效時採用（含正規化）", () => {
  assert.equal(resolveFallbackLang("en"), "en");
  assert.equal(resolveFallbackLang("ZH-TW"), "zh");
  assert.equal(resolveFallbackLang("  zh  "), "zh");
});

test("resolveFallbackLang：未設定／空白／無效一律落到內建預設 en，不拋例外", () => {
  assert.equal(resolveFallbackLang(undefined), "en");
  assert.equal(resolveFallbackLang(""), "en");
  assert.equal(resolveFallbackLang("   "), "en");
  assert.equal(resolveFallbackLang("fr"), "en");
});

// plan_i18n_v1.3.md §二之2：九項組合表。resolveLang 的公開簽名不變（cliLangRaw, envLangRaw
// → Lang，原名 TicketLang，T7a 更名，失敗拋 DispatchError）；本輪只改它拋出的訊息內容與
// 語言選擇，見下方各測試。

test("resolveLang #1：--lang 有效時直接採用，不驗 DISPATCH_LANG（即使它是壞的）", () => {
  assert.equal(resolveLang("en", "totally-bogus-env-value"), "en");
});

test("resolveLang #2：無 --lang，DISPATCH_LANG 有效 → 用 env", () => {
  assert.equal(resolveLang(undefined, "zh-tw"), "zh");
});

test("resolveLang #3：無 --lang，DISPATCH_LANG 無效 → 中止，訊息用內建預設語言（en），且指名是環境變數不是旗標", () => {
  assert.throws(
    () => resolveLang(undefined, "fr"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.exitCode, 2);
      assert.equal(
        err.message,
        m("en", "invalidEnvLang", "fr", m("en", "availableValuesSuffix", m("en", "availableLangValues"))),
      );
      assert.doesNotMatch(err.message, /^--lang/);
      return true;
    },
  );
});

test("resolveLang #4a：--lang 無效、env 也無效 → 中止，訊息用內建預設語言（en），且一併指出 env 也是壞的（避免兩步打地鼠）", () => {
  assert.throws(
    () => resolveLang("bogus-flag", "bogus-env"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.exitCode, 2);
      assert.equal(
        err.message,
        m(
          "en",
          "invalidLangFlag",
          "bogus-flag",
          m("en", "availableValuesSuffix", m("en", "availableLangValues")),
          m("en", "invalidEnvAlsoNote", "bogus-env"),
        ),
      );
      return true;
    },
  );
});

test("resolveLang #4b：--lang 無效，env 有效 → 訊息改用 env 的語言（不是內建預設），且不聲稱 env 也壞", () => {
  assert.throws(
    () => resolveLang("bogus-flag", "zh-tw"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(
        err.message,
        m(
          "zh",
          "invalidLangFlag",
          "bogus-flag",
          m("zh", "availableValuesSuffix", m("zh", "availableLangValues")),
          "",
        ),
      );
      return true;
    },
  );
});

test("resolveLang #7：DISPATCH_LANG 為空字串或全空白 → 視為未設定，落到內建預設，不中止", () => {
  assert.equal(resolveLang(undefined, ""), "en");
  assert.equal(resolveLang(undefined, "   "), "en");
  assert.equal(resolveLang(undefined, undefined), "en");
});

// v1.3 §二之2 #8 的另一半：resolveLang 本身只看最終傳入的字串，「最後一個值」是
// parseArgs 的責任（見上方 parseArgs 測試），這裡確認 resolveLang 對此無感、照常判定。
test("resolveLang #8：收到的已是 parseArgs 解出的最後一個值時，判定不受重複次數影響", () => {
  assert.equal(resolveLang("zh-tw", undefined), "zh");
});

// impl_tickets_i18n_stage1.md T3b／plan_i18n_v1.2.md §5.5：以下是「格式斷言」，不是「訊息斷言」。
// 期望值一律手寫成字面字串，不透過 m(lang, key, ...) 重建——若透過 m() 重建，一旦 messages.ts
// 內部的參數順序被打亂，actual 與 expected 會走過同一個（有 bug 的）樣板得出同一個錯誤結果，
// 測試永遠不會紅。這正是本工單要守住的東西：eventSpokeEnd 的 latencyMs／totalTokens、
// stdoutSummaryLine 的 tokens／latencyMs 是相鄰同型參數，只有手寫字面值才擋得住對調。
//
// formatEvent 的 "round" 事件（純 usage/toolCalls 事件，非未知欄位告警）本身是純 ASCII、
// 兩語言逐字相同（見 cli-args.ts 內註解），不必經 messages.ts——T3b 驗收時記錄為僅剩的
// 覆蓋缺口（7 case 測了 6 個），風險低但補起來只要 3 行，T7a〈E〉補上，formatEvent 至此
// 100% case 覆蓋。

test("formatEvent：round（純 ASCII，兩語言逐字相同，不經 messages.ts）", () => {
  const event: RunEvent = {
    type: "round",
    agent: "hole-finder",
    round: 4,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, available: true },
    hasToolCalls: true,
  };
  const expected =
    '[hole-finder] round 4 usage={"inputTokens":100,"outputTokens":50,"totalTokens":150,"available":true} toolCalls=true';
  assert.equal(formatEvent(event, "zh"), expected);
  assert.equal(formatEvent(event, "en"), expected);
});

test("formatEvent：spoke_start（zh／en）", () => {
  const event: RunEvent = { type: "spoke_start", agent: "hole-finder", provider: "openai", model: "gpt-5" };
  assert.equal(formatEvent(event, "zh"), "[hole-finder] 開始 → openai/gpt-5");
  assert.equal(formatEvent(event, "en"), "[hole-finder] started → openai/gpt-5");
});

test("formatEvent：unknown_usage_keys（zh／en）", () => {
  const event: RunEvent = {
    type: "unknown_usage_keys",
    agent: "hole-finder",
    round: 3,
    keys: ["cache_read_tokens", "beta_tokens"],
  };
  assert.equal(
    formatEvent(event, "zh"),
    "[hole-finder] ⚠ round 3 出現未知 usage 欄位：cache_read_tokens, beta_tokens",
  );
  assert.equal(
    formatEvent(event, "en"),
    "[hole-finder] ⚠ round 3 has unknown usage field(s): cache_read_tokens, beta_tokens",
  );
});

test("formatEvent：tool_call 允許（zh／en）", () => {
  const event: RunEvent = { type: "tool_call", agent: "hole-finder", path: "src/foo.ts", allowed: true };
  assert.equal(formatEvent(event, "zh"), "[hole-finder] read_file(src/foo.ts) 允許");
  assert.equal(formatEvent(event, "en"), "[hole-finder] read_file(src/foo.ts) allowed");
});

test("formatEvent：tool_call 拒絕（zh／en）", () => {
  const event: RunEvent = {
    type: "tool_call",
    agent: "hole-finder",
    path: "../outside.ts",
    allowed: false,
    reason: "outside_allowlist",
  };
  assert.equal(formatEvent(event, "zh"), "[hole-finder] read_file(../outside.ts) 拒絕(outside_allowlist)");
  assert.equal(formatEvent(event, "en"), "[hole-finder] read_file(../outside.ts) rejected(outside_allowlist)");
});

test("formatEvent：rate_limit_wait（zh／en）", () => {
  const event: RunEvent = { type: "rate_limit_wait", agent: "hole-finder", seconds: 12, source: "retry-after" };
  assert.equal(formatEvent(event, "zh"), "[hole-finder] 429，等待 12s（來源：retry-after）");
  assert.equal(formatEvent(event, "en"), "[hole-finder] 429, waiting 12s (source: retry-after)");
});

test("formatEvent：round_error（zh／en）", () => {
  const event: RunEvent = {
    type: "round_error",
    agent: "hole-finder",
    round: 2,
    status: 500,
    message: "internal error",
  };
  assert.equal(formatEvent(event, "zh"), "[hole-finder] ⚠ round 2 錯誤 status=500：internal error");
  assert.equal(formatEvent(event, "en"), "[hole-finder] ⚠ round 2 error status=500: internal error");
});

// eventSpokeEnd 是本工單風險最高的一則：latencyMs 與 totalTokens 相鄰同型（皆為 number）。
// 刻意選兩個不同且不對稱的數字（1234 ≠ 56789），對調後兩語言的輸出都會可辨識地變成錯的。
test("formatEvent：spoke_end 含價目與 budgetTrigger（zh／en）——latencyMs／totalTokens 不得對調", () => {
  const event: RunEvent = {
    type: "spoke_end",
    agent: "hole-finder",
    status: "truncated:budget",
    latencyMs: 1234,
    totalTokens: 56789,
    estimatedPromptTokens: 100,
    costUsd: 0.0512,
    budgetTrigger: "reasoning",
  };
  assert.equal(
    formatEvent(event, "zh"),
    "[hole-finder] 結束 status=truncated:budget latency=1234ms totalTokens=56789 cost=$0.0512 budgetTrigger=reasoning",
  );
  assert.equal(
    formatEvent(event, "en"),
    "[hole-finder] finished status=truncated:budget latency=1234ms totalTokens=56789 cost=$0.0512 budgetTrigger=reasoning",
  );
});

test("formatEvent：spoke_end 無價目資料、無 budgetTrigger（zh／en）", () => {
  const event: RunEvent = {
    type: "spoke_end",
    agent: "hole-finder",
    status: "succeeded",
    latencyMs: 999,
    totalTokens: 111,
    estimatedPromptTokens: 50,
    costUsd: null,
  };
  assert.equal(
    formatEvent(event, "zh"),
    "[hole-finder] 結束 status=succeeded latency=999ms totalTokens=111 cost=無價目資料",
  );
  assert.equal(
    formatEvent(event, "en"),
    "[hole-finder] finished status=succeeded latency=999ms totalTokens=111 cost=No pricing data",
  );
});

// buildStdoutSummary（T3b：搬出 cli.ts，見 cli-args.ts 內註解）——stdoutSummaryLine 的
// tokens／latencyMs 同樣相鄰同型，用不對稱數字驗證未被對調。

function makeResult(overrides: Partial<SpokeRunResult>): SpokeRunResult {
  return {
    agent: "hole-finder",
    provider: "openai",
    api: "responses",
    modelRequested: "gpt-5",
    modelReturned: "gpt-5",
    store: "n/a",
    status: "succeeded",
    finalText: "ok",
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, available: true },
    costUsd: 0.01,
    finishReason: "stop",
    finishReasonRaw: "stop",
    toolCalls: [],
    rateLimitHits: [],
    unknownUsageKeys: [],
    attempts: 1,
    errors: [],
    requestId: null,
    startedAt: 0,
    finishedAt: 0,
    latencyMs: 100,
    waitedMs: 0,
    estimatedPromptTokens: 10,
    rawRequests: [],
    rawResponses: [],
    rawErrors: [],
    ...overrides,
  };
}

test("buildStdoutSummary：單一 spoke，latencyMs／tokens 不對稱數字（zh／en）", () => {
  const results: SpokeRunResult[] = [
    makeResult({
      agent: "hole-finder",
      status: "succeeded",
      modelReturned: "gpt-5",
      usage: { inputTokens: 100, outputTokens: 200, totalTokens: 7654, available: true },
      costUsd: 0.0512,
      latencyMs: 321,
    }),
  ];
  assert.equal(
    buildStdoutSummary(results, "zh"),
    "hole-finder: succeeded  model=gpt-5  token=7654  cost=$0.0512  耗時=321ms",
  );
  assert.equal(
    buildStdoutSummary(results, "en"),
    "hole-finder: succeeded  model=gpt-5  token=7654  cost=$0.0512  elapsed=321ms",
  );
});

test("buildStdoutSummary：多支 spoke 逐行、以換行連接，並涵蓋無價目資料與 modelReturned=null（zh／en）", () => {
  const results: SpokeRunResult[] = [
    makeResult({
      agent: "spoke-a",
      status: "succeeded",
      modelReturned: "gpt-5",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, available: true },
      costUsd: 0.02,
      latencyMs: 111,
    }),
    makeResult({
      agent: "spoke-b",
      status: "failed",
      modelReturned: null,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: false },
      costUsd: null,
      latencyMs: 222,
    }),
  ];
  assert.equal(
    buildStdoutSummary(results, "zh"),
    [
      "spoke-a: succeeded  model=gpt-5  token=30  cost=$0.0200  耗時=111ms",
      "spoke-b: failed  model=—  token=0  cost=無價目資料  耗時=222ms",
    ].join("\n"),
  );
  assert.equal(
    buildStdoutSummary(results, "en"),
    [
      "spoke-a: succeeded  model=gpt-5  token=30  cost=$0.0200  elapsed=111ms",
      "spoke-b: failed  model=—  token=0  cost=No pricing data  elapsed=222ms",
    ].join("\n"),
  );
});

// 熱修補（票 C 驗收）：DOWAFU_HTTP_PORT 原本是死的——只寫在 serve() 的參數預設值，
// 而 cli.ts 一律傳具體的 options.httpPort，所以那條路永遠走不到。環境變數看起來支援、
// 實際被靜默忽略，而同一行呼叫裡 DOWAFU_MAX_CONCURRENT 是活的。優先序必須是
// 旗標 > 環境變數 > 內建預設，三段都要驗到。
test("parseArgs：--http-port > DOWAFU_HTTP_PORT > 內建預設", () => {
  const saved = process.env.DOWAFU_HTTP_PORT;
  try {
    delete process.env.DOWAFU_HTTP_PORT;
    const fallback = parseArgs(["serve"], "en");
    assert.equal(fallback.mode, "serve");
    const builtIn = fallback.mode === "serve" ? fallback.options.httpPort : -1;

    process.env.DOWAFU_HTTP_PORT = "7777";
    const fromEnv = parseArgs(["serve"], "en");
    assert.equal(fromEnv.mode === "serve" && fromEnv.options.httpPort, 7777, "環境變數必須生效");
    assert.notEqual(builtIn, 7777, "測試若與內建預設同值就證明不了任何事");

    const fromFlag = parseArgs(["serve", "--http-port", "7888"], "en");
    assert.equal(fromFlag.mode === "serve" && fromFlag.options.httpPort, 7888, "旗標必須壓過環境變數");

    process.env.DOWAFU_HTTP_PORT = "not-a-port";
    const bogus = parseArgs(["serve"], "en");
    assert.equal(bogus.mode === "serve" && bogus.options.httpPort, builtIn, "無效值要退回內建預設，不是 NaN");
  } finally {
    if (saved === undefined) delete process.env.DOWAFU_HTTP_PORT;
    else process.env.DOWAFU_HTTP_PORT = saved;
  }
});
