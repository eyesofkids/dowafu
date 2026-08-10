import { test } from "node:test";
import assert from "node:assert/strict";
import { runSpoke, type RunEvent, type RunnerOptions } from "./runner.js";
import { Semaphore } from "./semaphore.js";
import { ProviderHttpError } from "./mask.js";
import { RawIntegrityError } from "./raw-integrity.js";
import type { Adapter, NormalizedUsage, SendResult, ToolCall } from "./types.js";
import type { ResolvedSpoke } from "./validate.js";

// plan_dispatch_v1.5.md §20「測試覆蓋要求」：runner.ts 的狀態機（truncated 三態、收束
// 呼叫）、429 重試迴圈、raw 完整性錯誤的不重試特判——全部透過 mock Adapter 驅動，
// 不打任何 API。Adapter 是介面契約，這是那層抽象換來的可測性。

const SPOKE: ResolvedSpoke = {
  agent: "hole-finder-cost",
  provider: "deepseek",
  providerConfig: {
    baseURL: "https://api.deepseek.com/v1",
    api: "responses",
    store: false,
    toolCalling: true,
    reasoning: { style: "deepseek", allowed: ["high"], default: "high" },
    models: [],
    charsPerToken: null,
    tpmLimit: null,
    maxSpokeTokens: null,
  },
  model: "deepseek-v4-flash",
  effort: "high",
  agentBody: "你是測試用 spoke。",
  questions: "1. 測試問題",
  allowSet: new Set<string>(),
  allowedReadsResolved: [],
  allowedReadsRelative: [],
};

function mkOptions(overrides: Partial<RunnerOptions> = {}): RunnerOptions {
  return {
    repoRoot: process.cwd(),
    timeoutMs: 5000,
    retries: 0,
    rateLimitRetries: 2,
    maxRateWaitSec: 5,
    maxToolCalls: 30,
    maxSpokeTokens: 400_000,
    maxSpokeReasoningTokens: 50_000,
    maxRoundReasoningTokens: null,
    charsPerToken: 1.0,
    semaphore: new Semaphore(1),
    onEvent: () => {},
    ...overrides,
  };
}

function mkResult(opts: {
  toolCalls?: ToolCall[];
  text?: string | null;
  usage?: Partial<NormalizedUsage>;
  usageRaw?: unknown;
}): SendResult {
  const toolCalls = opts.toolCalls ?? [];
  return {
    turn: { role: "assistant", raw: [{ type: "message", id: "m1" }], toolCalls },
    usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20, available: true, ...opts.usage },
    usageRaw: opts.usageRaw ?? {},
    meta: {
      modelReturned: "mock-model",
      finishReason: "stop",
      finishReasonRaw: "completed",
      requestId: "req-mock",
      store: "false",
      text: opts.text ?? null,
    },
    request: { mock: true },
    response: { mock: true },
  };
}

type ScriptStep = SendResult | { throwStatus: number; message: string; headers?: Record<string, string> };

// callCount() 是方法，不是屬性——刻意如此：呼叫端若寫成
// `const { adapter, calls } = createScriptedAdapter(...)` 解構出一個屬性，只會拿到
// 建立當下的快照（0），之後 adapter.send() 內部遞增的次數不會反映到那個變數上。
// 用方法強迫每次讀取都重新取值，避免這個容易誤踩的坑。
function createScriptedAdapter(steps: ScriptStep[]): { adapter: Adapter; callCount: () => number } {
  let i = 0;
  let calls = 0;
  const adapter: Adapter = {
    async send() {
      calls++;
      const step = steps[Math.min(i, steps.length - 1)];
      i++;
      if ("throwStatus" in step) {
        throw new ProviderHttpError(step.message, step.throwStatus, step.headers ?? {}, {});
      }
      return step;
    },
  };
  return { adapter, callCount: () => calls };
}

test("succeeded：單輪直接給答案，無 tool call", async () => {
  const { adapter } = createScriptedAdapter([
    mkResult({ toolCalls: [], text: "回報內容\n以上為觀察與問題，採用與否由 hub 與使用者裁決。" }),
  ]);
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions());
  assert.equal(result.status, "succeeded");
  assert.match(result.finalText ?? "", /採用與否由 hub/);
});

test("truncated:tool_limit：超過 --max-tool-calls，經收束呼叫產出，被拒呼叫記入 toolCalls[]", async () => {
  const { adapter } = createScriptedAdapter([
    mkResult({
      toolCalls: [
        { id: "c1", name: "read_file", args: { path: "a.txt" } },
        { id: "c2", name: "read_file", args: { path: "b.txt" } },
      ],
    }),
    mkResult({ toolCalls: [], text: "收束後的回報" }),
  ]);
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions({ maxToolCalls: 1 }));
  assert.equal(result.status, "truncated:tool_limit");
  assert.equal(result.finalText, "收束後的回報");
  const limitLog = result.toolCalls.find((t) => t.reason === "tool_limit_exceeded");
  assert.ok(limitLog, "觸限被拒的呼叫應記入 toolCalls[]，不是靜默丟棄");
  assert.equal(limitLog?.allowed, false);
});

test("truncated:budget：累積 usage 達 --max-spoke-tokens，不執行該輪 tool call、直接收束", async () => {
  const { adapter } = createScriptedAdapter([
    mkResult({
      toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }],
      usage: { totalTokens: 500 },
    }),
    mkResult({ toolCalls: [], text: "收束後的回報" }),
  ]);
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions({ maxSpokeTokens: 100 }));
  assert.equal(result.status, "truncated:budget");
  assert.equal(result.budgetTrigger, "total");
  assert.equal(result.finalText, "收束後的回報");
  // 觸發 budget 那輪的 tool call 不該被執行（沒必要再花錢讀檔案）
  assert.equal(result.toolCalls.length, 0);
});

test("truncated:budget（budgetTrigger:reasoning）：累積 reasoningTokens 超過 --max-spoke-reasoning-tokens", async () => {
  const { adapter } = createScriptedAdapter([
    mkResult({
      toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }],
      usage: { reasoningTokens: 60_000 },
    }),
    mkResult({ toolCalls: [], text: "收束後的回報" }),
  ]);
  const result = await runSpoke(
    SPOKE,
    adapter,
    "tmp/dispatch/fake-ticket",
    mkOptions({ maxSpokeReasoningTokens: 50_000 }),
  );
  assert.equal(result.status, "truncated:budget");
  assert.equal(result.budgetTrigger, "reasoning");
  assert.equal(result.finalText, "收束後的回報");
});

test("truncated:budget（budgetTrigger:reasoning_round）：單輪 reasoningTokens 超過 --max-round-reasoning-tokens——累積上限抓不到的單點尖峰", async () => {
  const { adapter } = createScriptedAdapter([
    // 累積僅 3000（遠低於 maxSpokeReasoningTokens 50000），但單輪尖峰超過 --max-round-reasoning-tokens
    mkResult({
      toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }],
      usage: { reasoningTokens: 3000 },
    }),
    mkResult({ toolCalls: [], text: "收束後的回報" }),
  ]);
  const result = await runSpoke(
    SPOKE,
    adapter,
    "tmp/dispatch/fake-ticket",
    mkOptions({ maxRoundReasoningTokens: 2000 }),
  );
  assert.equal(result.status, "truncated:budget");
  assert.equal(result.budgetTrigger, "reasoning_round");
  assert.equal(result.finalText, "收束後的回報");
});

// plan_dispatch_v1.12.md §14 核對清單第 2 項：「同一個 spoke 的不同輪次可能一輪有、
// 一輪沒有，累積邏輯不得因 undefined 而歸零或中斷」——先前只靠讀 sumUsage 原始碼確認，
// 未有測試覆蓋這個跨輪次情境，補上。中間那輪 reasoningTokens 缺席（真實情況：gemini
// 「按需出現」，見 v1.12 §12／§20），累積值不得被那一輪重置為 0，第三輪疊加後仍要正確
// 觸發。
test("推理上限：跨輪次一輪有 reasoningTokens、一輪沒有，累積不因 undefined 那輪歸零或中斷", async () => {
  const { adapter } = createScriptedAdapter([
    mkResult({
      toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }],
      usage: { reasoningTokens: 30_000 },
    }),
    mkResult({
      toolCalls: [{ id: "c2", name: "read_file", args: { path: "b.txt" } }],
      usage: {}, // reasoningTokens 缺席這一輪，非 0
    }),
    mkResult({
      toolCalls: [{ id: "c3", name: "read_file", args: { path: "c.txt" } }],
      usage: { reasoningTokens: 15_000 },
    }),
    mkResult({ toolCalls: [], text: "收束後的回報" }),
  ]);
  const result = await runSpoke(
    SPOKE,
    adapter,
    "tmp/dispatch/fake-ticket",
    mkOptions({ maxSpokeReasoningTokens: 40_000, maxRoundReasoningTokens: null }),
  );
  // 30,000（第一輪）+ 0（第二輪缺席，非重置整體為 0）+ 15,000（第三輪）= 45,000 > 40,000
  assert.equal(result.status, "truncated:budget");
  assert.equal(result.budgetTrigger, "reasoning");
  assert.equal(result.finalText, "收束後的回報");
  // 第二輪的 tool call 必須有被執行到（累積沒有因 undefined 那輪提早中斷收束）
  assert.ok(result.toolCalls.some((t) => t.path === "b.txt"));
});

test("推理上限：--max-round-reasoning-tokens 預設 null 時不檢查，即使單輪推理很高、該輪仍有 tool call 也不觸發收束", async () => {
  const { adapter } = createScriptedAdapter([
    mkResult({
      toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }],
      usage: { reasoningTokens: 999_999 },
    }),
    mkResult({ toolCalls: [], text: "正常完成" }),
  ]);
  const result = await runSpoke(
    SPOKE,
    adapter,
    "tmp/dispatch/fake-ticket",
    mkOptions({ maxRoundReasoningTokens: null, maxSpokeReasoningTokens: 10_000_000 }),
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.budgetTrigger, undefined);
  assert.equal(result.finalText, "正常完成");
});

test("truncated:usage_unavailable：usage.available:false 且該輪有 tool call → 收束後仍標記此狀態", async () => {
  const { adapter } = createScriptedAdapter([
    mkResult({
      toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }],
      usage: { available: false },
    }),
    mkResult({ toolCalls: [], text: "收束後的回報" }),
  ]);
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions());
  assert.equal(result.status, "truncated:usage_unavailable");
  assert.equal(result.finalText, "收束後的回報");
});

test("truncated:usage_unavailable：即使該輪已無 tool call（本可視為完成），仍標記此狀態而非 succeeded", async () => {
  const { adapter } = createScriptedAdapter([
    mkResult({ toolCalls: [], text: "直接給答案但 usage 不可用", usage: { available: false } }),
  ]);
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions());
  assert.equal(result.status, "truncated:usage_unavailable");
  assert.equal(result.finalText, "直接給答案但 usage 不可用");
});

test("truncated:rate_limit：先有內容，429 用盡放棄後標記 truncated（不是 failed）", async () => {
  const { adapter } = createScriptedAdapter([
    mkResult({ toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }] }),
    { throwStatus: 429, message: "rate limited", headers: { "retry-after": "0.01" } },
  ]);
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions({ rateLimitRetries: 2 }));
  assert.equal(result.status, "truncated:rate_limit");
  assert.equal(result.rateLimitHits.length, 2, "撞牆 2 次未超限才等待，第 3 次超限直接放棄不等待");
  assert.ok(result.rateLimitHits.every((h) => h.source === "header"));
});

test("failed：429 從第一輪就撞、耗盡後無任何內容 → failed（非 truncated）", async () => {
  const { adapter } = createScriptedAdapter([
    { throwStatus: 429, message: "rate limited", headers: { "retry-after": "0.01" } },
  ]);
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions({ rateLimitRetries: 1 }));
  assert.equal(result.status, "failed");
  assert.equal(result.finalText, null);
});

test("failed：一般錯誤（非 429）重試至 --retries 用盡", async () => {
  // retries:1 而非較大值——sendWithResilience 的一般失敗退避是真的 setTimeout（1s/4s，
  // §13 明訂固定值，不因測試而改production行為），重試次數越多測試越慢，1 次已足夠驗證
  // 「重試後仍失敗→failed」與呼叫次數。
  const { adapter, callCount } = createScriptedAdapter([{ throwStatus: 500, message: "internal error" }]);
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions({ retries: 1 }));
  assert.equal(result.status, "failed");
  assert.equal(callCount(), 2, "重試 1 次代表最壞呼叫 1+1=2 次");
});

test("truncated:error（v1.6 §13 新增）：非收束輪次的一般錯誤重試用盡，但已有部分內容", async () => {
  const { adapter, callCount } = createScriptedAdapter([
    mkResult({ toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }] }), // round1 成功且有內容
    { throwStatus: 500, message: "internal error on round 2" }, // round2 起一路失敗
  ]);
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions({ retries: 1 }));
  assert.equal(result.status, "truncated:error");
  assert.equal(callCount(), 1 + 1 + 1, "round1 一次成功 + round2 的 1+retries(1) 次失敗嘗試");
});

test("收束呼叫一般失敗：不重試（即使 --retries 設很大），但已有部分內容 → truncated:error（v1.8 §13 修正，非 failed）", async () => {
  const { adapter, callCount } = createScriptedAdapter([
    mkResult({ toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }], usage: { totalTokens: 999 } }),
    { throwStatus: 500, message: "finalize call failed" },
  ]);
  const result = await runSpoke(
    SPOKE,
    adapter,
    "tmp/dispatch/fake-ticket",
    mkOptions({ maxSpokeTokens: 100, retries: 5 }),
  );
  // v1.6→v1.7 的「終局」只指不再重試，不指狀態標記；v1.7 曾寫對規則但 runner.ts 的
  // 實作仍留著 !finalizeMode 條件（v1.8 §13 才修正這個字面矛盾）。round1 已有內容
  // （已付費），故即使收束呼叫本身失敗，狀態仍是 truncated:error 而非 failed。
  assert.equal(result.status, "truncated:error");
  assert.equal(callCount(), 2, "收束呼叫一般失敗不該重試，總呼叫數應為 2（round1 ＋ 一次收束）");
});

test("錯誤分類：確定性 4xx（如 400）不重試，即使 --retries 設很大也只呼叫一次", async () => {
  const { adapter, callCount } = createScriptedAdapter([{ throwStatus: 400, message: "bad request" }]);
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions({ retries: 5 }));
  assert.equal(result.status, "failed");
  assert.equal(callCount(), 1, "確定性錯誤重試必然再撞同一個錯，不該消耗任何 retries");
});

test("錯誤分類：408 視為暫時性，會重試至 --retries 用盡", async () => {
  const { adapter, callCount } = createScriptedAdapter([{ throwStatus: 408, message: "request timeout" }]);
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions({ retries: 1 }));
  assert.equal(result.status, "failed");
  assert.equal(callCount(), 2, "408 屬暫時性，應重試 1 次（1+1=2 次呼叫）");
});

test("RawIntegrityError：立即判定 failed，不進入一般重試迴圈", async () => {
  let callCount = 0;
  const adapter: Adapter = {
    async send() {
      callCount++;
      throw new RawIntegrityError("模擬 raw 完整性違反");
    },
  };
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions({ retries: 3 }));
  assert.equal(result.status, "failed");
  assert.equal(callCount, 1, "raw 完整性錯誤是確定性 bug，重試不可能成功，不該消耗 retries");
  assert.ok(result.errors.some((e) => e.includes("raw 完整性檢查失敗")));
});

// plan_dispatch_v2.6.md §28 測試 6：同一 agent 同一未知 key 出現兩輪，一次派工內只在
// 首次出現時發事件與寫入 summary（規格五）。第 10 次派工單支 spoke 跑到 29 輪，不去重
// 的話一個新欄位會報 29 次。
test("unknown_usage_keys：同一 agent 同一未知 key 出現兩輪，只發一次事件（v2.6 §28 測試 6，規格五去重）", async () => {
  const { adapter } = createScriptedAdapter([
    mkResult({
      toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }],
      usageRaw: { input_tokens: 10, output_tokens: 10, total_tokens: 20, brand_new_field: 1 },
    }),
    mkResult({
      toolCalls: [],
      text: "完成",
      usageRaw: { input_tokens: 5, output_tokens: 5, total_tokens: 10, brand_new_field: 2 },
    }),
  ]);
  const events: unknown[] = [];
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions({ onEvent: (e) => events.push(e) }));
  const unknownEvents = events.filter((e) => (e as { type: string }).type === "unknown_usage_keys");
  assert.equal(unknownEvents.length, 1, "同一 key 兩輪出現，事件只該發一次");
  assert.deepEqual((unknownEvents[0] as { keys: string[] }).keys, ["brand_new_field"]);
  assert.deepEqual(result.unknownUsageKeys, ["brand_new_field"], "累積結果去重後只有一筆");
});

test("unknown_usage_keys：完全是已知 key 時，不發事件、unknownUsageKeys 為空陣列", async () => {
  const { adapter } = createScriptedAdapter([
    mkResult({
      toolCalls: [],
      text: "完成",
      usageRaw: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    }),
  ]);
  const events: unknown[] = [];
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions({ onEvent: (e) => events.push(e) }));
  assert.equal(events.filter((e) => (e as { type: string }).type === "unknown_usage_keys").length, 0);
  assert.deepEqual(result.unknownUsageKeys, []);
});

// 規格六：偵測器自身丟例外不得影響派工——usageRaw 是字串（非物件）時 findUnknownUsageKeys
// 已在內部回傳空陣列而不丟例外，但這裡額外確認即使正規化層給出非預期形狀，spoke 仍正常完成。
test("unknown_usage_keys：usageRaw 為非物件形狀時不影響 spoke 正常完成", async () => {
  const { adapter } = createScriptedAdapter([mkResult({ toolCalls: [], text: "完成", usageRaw: "unexpected" })]);
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions());
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.unknownUsageKeys, []);
});

test("白名單拒絕的 tool 呼叫仍記入 toolCalls[]，spoke 可依此繼續完成（不因被拒而中斷）", async () => {
  const { adapter } = createScriptedAdapter([
    mkResult({ toolCalls: [{ id: "c1", name: "read_file", args: { path: "_docs/secret.md" } }] }),
    mkResult({ toolCalls: [], text: "在無法讀取後仍給出回報" }),
  ]);
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions());
  assert.equal(result.status, "succeeded");
  assert.equal(result.toolCalls[0].allowed, false);
  assert.equal(result.finalText, "在無法讀取後仍給出回報");
});

// plan_fixes_v1.0.md §6：失敗時 raw/*.json 是 []、run.jsonl 沒有 error 欄——中斷或失敗時
// 完全沒有線索。rawErrors[] 與 round_error 事件是這個缺口的修補，逐次錯誤都記（不只終局
// 那次），message 須經 mask.ts 遮蔽。
test("rawErrors：一般錯誤重試用盡，每次嘗試各記一筆，round 標對", async () => {
  const { adapter } = createScriptedAdapter([{ throwStatus: 500, message: "internal error" }]);
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions({ retries: 1 }));
  assert.equal(result.status, "failed");
  assert.equal(result.rawErrors.length, 2, "重試 1 次代表最壞呼叫 1+1=2 次，每次都應記一筆");
  assert.ok(result.rawErrors.every((e) => e.round === 1), "尚未進入 round 2，兩次嘗試都屬 round 1");
  assert.ok(result.rawErrors.every((e) => e.status === 500));
  assert.ok(result.rawErrors.every((e) => e.message.includes("internal error")));
});

test("rawErrors：跨輪失敗時 round 遞增，與 round 事件對齊", async () => {
  const { adapter } = createScriptedAdapter([
    mkResult({ toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }] }), // round1 成功
    { throwStatus: 500, message: "internal error on round 2" }, // round2 起失敗
  ]);
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions({ retries: 0 }));
  assert.equal(result.status, "truncated:error");
  assert.equal(result.rawErrors.length, 1);
  assert.equal(result.rawErrors[0].round, 2, "失敗發生在 round2，不是 round1");
});

test("rawErrors：RawIntegrityError 也記一筆，status 為 null（非 HTTP 錯誤）", async () => {
  const adapter: Adapter = {
    async send() {
      throw new RawIntegrityError("模擬 raw 完整性違反");
    },
  };
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions({ retries: 3 }));
  assert.equal(result.rawErrors.length, 1);
  assert.equal(result.rawErrors[0].status, null);
  assert.match(result.rawErrors[0].message, /raw 完整性檢查失敗/);
});

test("rawErrors：成功的 spoke 為空陣列（沒撞過任何錯誤）", async () => {
  const { adapter } = createScriptedAdapter([mkResult({ toolCalls: [], text: "一次就成功" })]);
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions());
  assert.deepEqual(result.rawErrors, []);
});

test("round_error 事件：每次錯誤都透過 onEvent 發出，攜帶 round／status／message", async () => {
  const { adapter } = createScriptedAdapter([{ throwStatus: 400, message: "bad request" }]);
  const events: RunEvent[] = [];
  const result = await runSpoke(SPOKE, adapter, "tmp/dispatch/fake-ticket", mkOptions({ onEvent: (e) => events.push(e) }));
  assert.equal(result.status, "failed");
  const roundErrors = events.filter((e): e is Extract<RunEvent, { type: "round_error" }> => e.type === "round_error");
  assert.equal(roundErrors.length, 1);
  assert.equal(roundErrors[0].round, 1);
  assert.equal(roundErrors[0].status, 400);
  assert.match(roundErrors[0].message ?? "", /bad request/);
});
