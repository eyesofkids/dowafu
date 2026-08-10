// plan_dispatch_v1.4.md §12：usage 正規化層。key 是 provider＋端點，不是只有 provider——
// 實測四套命名互不相同（facts_dispatch.md）。純函式，供單元測試。

import type { NormalizedUsage, ProviderConfig } from "./types.js";

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// openai／deepseek 的 /v1/responses：input_tokens / output_tokens / total_tokens
export function normalizeResponsesUsage(raw: unknown): NormalizedUsage {
  const r = (raw ?? {}) as Record<string, unknown>;
  const inputTokens = isNumber(r.input_tokens) ? r.input_tokens : undefined;
  const outputTokens = isNumber(r.output_tokens) ? r.output_tokens : undefined;
  let totalTokens = isNumber(r.total_tokens) ? r.total_tokens : undefined;
  // 缺 totalTokens 一律以 input + output 補（§12）
  if (totalTokens === undefined && inputTokens !== undefined && outputTokens !== undefined) {
    totalTokens = inputTokens + outputTokens;
  }
  const inputDetails = r.input_tokens_details as Record<string, unknown> | undefined;
  const outputDetails = r.output_tokens_details as Record<string, unknown> | undefined;
  const cachedTokens = isNumber(inputDetails?.cached_tokens) ? inputDetails!.cached_tokens : undefined;
  const cacheWriteTokens = isNumber(inputDetails?.cache_write_tokens)
    ? inputDetails!.cache_write_tokens
    : undefined;
  const reasoningTokens = isNumber(outputDetails?.reasoning_tokens)
    ? outputDetails!.reasoning_tokens
    : undefined;

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: totalTokens ?? 0,
    cachedTokens,
    cacheWriteTokens,
    reasoningTokens,
    // v2.5 規格二：快取欄位不得影響 available。openai 的 input_tokens_details 有一種形狀
    // （('image_tokens','text_tokens')，實測 79 次）完全沒有 cache_write_tokens，屬正常情形。
    available: inputTokens !== undefined && outputTokens !== undefined && totalTokens !== undefined,
  };
}

// gemini generateContent：promptTokenCount / candidatesTokenCount / totalTokenCount。
// thoughtsTokenCount 是 v1.8 才新增的欄位——開啟 thinkingConfig 之前的實測從未觀察到它
// （facts_dispatch.md 寫的是「無對應欄位」），§20 驗證腳本確認開啟後會出現且隨值縮放
// （low 133 → high 1,805）。與 openai 的 reasoning_tokens 同樣只記錄不參與 totalTokens
// 計算——totalTokenCount 由 API 直接給值時一律優先採用，不重算。
export function normalizeGeminiUsage(raw: unknown): NormalizedUsage {
  const r = (raw ?? {}) as Record<string, unknown>;
  const inputTokens = isNumber(r.promptTokenCount) ? r.promptTokenCount : undefined;
  const outputTokens = isNumber(r.candidatesTokenCount) ? r.candidatesTokenCount : undefined;
  const reasoningTokens = isNumber(r.thoughtsTokenCount) ? r.thoughtsTokenCount : undefined;
  const cachedTokens = isNumber(r.cachedContentTokenCount) ? r.cachedContentTokenCount : undefined;
  let totalTokens = isNumber(r.totalTokenCount) ? r.totalTokenCount : undefined;
  // plan_dispatch_v1.12.md §12／§14：gemini 的帳目關係是 promptTokenCount +
  // candidatesTokenCount + thoughtsTokenCount = totalTokenCount（實測 592+79+321=992）——
  // thoughtsTokenCount 不是 candidatesTokenCount 的子集，與 openai／deepseek 的
  // reasoning_tokens ⊆ output_tokens 相反。缺 totalTokenCount 時的回補公式若沿用
  // input+output（子集假設下才成立），會在 thoughtsTokenCount 存在時漏算，故此處須把
  // reasoningTokens 一併算入。
  if (totalTokens === undefined && inputTokens !== undefined && outputTokens !== undefined) {
    totalTokens = inputTokens + outputTokens + (reasoningTokens ?? 0);
  }

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: totalTokens ?? 0,
    reasoningTokens,
    cachedTokens,
    // v2.5 規格二：implicit caching 下限 4,096 token，小 prompt 本來就不會有這個欄位，
    // 缺席不得使 available 轉 false（facts_dispatch.md 2026-08-08 更正條目二）
    available: inputTokens !== undefined && outputTokens !== undefined && totalTokens !== undefined,
  };
}

// plan_dispatch_v2.7.md §29 規格十／十一：anthropic Messages API 的 usage 欄位名，實測
// 確認（scripts/verify-providers.ts，見 facts_dispatch.md）——input_tokens／
// cache_creation_input_tokens／cache_read_input_tokens／cache_creation／output_tokens／
// output_tokens_details（含 thinking_tokens）／service_tier／inference_geo。
export function normalizeAnthropicUsage(raw: unknown): NormalizedUsage {
  const r = (raw ?? {}) as Record<string, unknown>;
  const inputTokens = isNumber(r.input_tokens) ? r.input_tokens : undefined;
  const outputTokens = isNumber(r.output_tokens) ? r.output_tokens : undefined;
  const cacheReadTokens = isNumber(r.cache_read_input_tokens) ? r.cache_read_input_tokens : undefined;
  const cacheCreationTokens = isNumber(r.cache_creation_input_tokens) ? r.cache_creation_input_tokens : undefined;
  const outputDetails = r.output_tokens_details as Record<string, unknown> | undefined;
  const reasoningTokens = isNumber(outputDetails?.thinking_tokens) ? outputDetails!.thinking_tokens : undefined;

  // 規格十：Anthropic 無 total_tokens 欄位，須自行加總。且 input_tokens 在有快取時不含快取
  // 部分（官方 usage 範例三者並列），故正確總量是 input+output+快取讀取+快取寫入的四者之和，
  // 不是 input+output 兩者（那個公式是 openai／deepseek 的形狀，此處會低估）。
  const totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0);

  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens,
    cachedTokens: cacheReadTokens,
    cacheWriteTokens: cacheCreationTokens,
    reasoningTokens,
    available: inputTokens !== undefined && outputTokens !== undefined,
  };
}

const STOP_VALUES = new Set(["completed", "STOP", "end_turn"]);

export function normalizeFinishReason(raw: string | null | undefined): {
  finishReason: string;
  finishReasonRaw: string | null;
} {
  const finishReasonRaw = raw ?? null;
  if (raw && STOP_VALUES.has(raw)) {
    return { finishReason: "stop", finishReasonRaw };
  }
  return { finishReason: raw ?? "unknown", finishReasonRaw };
}

// v2.5 規格三：兩邊皆缺席時輸出 undefined，不是 0——「沒有資料」與「量測值為 0」必須
// 可區分，否則 run.jsonl 裡的 0 會被誤讀為一次量測結果。
function addOptional(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

export function sumUsage(a: NormalizedUsage, b: NormalizedUsage): NormalizedUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cachedTokens: addOptional(a.cachedTokens, b.cachedTokens),
    cacheWriteTokens: addOptional(a.cacheWriteTokens, b.cacheWriteTokens),
    reasoningTokens: addOptional(a.reasoningTokens, b.reasoningTokens),
    available: a.available && b.available,
  };
}

export const EMPTY_USAGE: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  available: true,
};

// plan_dispatch_v2.6.md §26 規格二：允許清單緊鄰對應的正規化函式，不放 providers.json——
// 「正規化層認得哪些 key」是程式內部知識，距離讀取邏輯越遠越容易漏更新（這正是本版要防
// 的事）。清單須含所有已知 key，不只「有讀的 key」；已知但刻意不讀的也要列入並註明理由，
// 否則每次派工都會誤報，把真正的新欄位訊號淹掉。清單依據：tmp/external-runs/ 十次真實
// 派工的 raw 全量掃描（§27），逐一開檔核對而非憑欄位名猜測。
const RESPONSES_USAGE_KEYS = new Set(["input_tokens", "output_tokens", "total_tokens", "input_tokens_details", "output_tokens_details"]);
const RESPONSES_INPUT_DETAILS_KEYS = new Set(["cached_tokens", "cache_write_tokens"]);
// image_tokens／text_tokens：已知，不參與計算。註：本機十次真實派工的 raw 裡，這兩個
// key 實際只出現在同一份 response 的另一個頂層欄位 tool_usage.image_gen.*_tokens_details
// （與 usage 完全無關的欄位，不在本偵測器掃描範圍內——見規格一），從未在
// usage.output_tokens_details 本身出現過。列在此處純屬防禦：即便官方日後把它併入
// usage.output_tokens_details，也不會被誤報成新欄位。
const RESPONSES_OUTPUT_DETAILS_KEYS = new Set(["reasoning_tokens", "image_tokens", "text_tokens"]);

const GEMINI_USAGE_KEYS = new Set([
  "promptTokenCount",
  "candidatesTokenCount",
  "totalTokenCount",
  "thoughtsTokenCount",
  "cachedContentTokenCount",
  "promptTokensDetails",
  "cacheTokensDetails", // 已知，不參與計算：cachedContentTokenCount 的 modality 拆分（v2.5 未讀，14 次）
  "serviceTier", // 已知，不參與計算
]);
// 規格一：巢狀節點只走已知的三個，不做無限遞迴——cacheTokensDetails 雖與
// promptTokensDetails 同形狀，但不在這三個之列，只列為已知頂層 key，不遞迴檢查其內容。
const GEMINI_PROMPT_DETAILS_ITEM_KEYS = new Set(["modality", "tokenCount"]);

// plan_dispatch_v2.7.md §29 規格七之二：以 scripts/verify-providers.ts 對真實 API 的回應
// 為準（見 facts_dispatch.md），不照官方文件猜——文件另提過 server_tool_use 這個欄位，但
// 本次實測（純 client-side read_file 工具，非 Anthropic 伺服器端工具）從未出現過，故不列入；
// 依 v2.6 §26 的既有紀律，未出現的欄位交由本偵測器在真正撞到時示警，再核對後補入，不預先
// 整批加入猜測值。
const ANTHROPIC_USAGE_KEYS = new Set([
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "cache_creation",
  "output_tokens_details",
  "service_tier",
  "inference_geo",
]);
const ANTHROPIC_CACHE_CREATION_KEYS = new Set(["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"]);
const ANTHROPIC_OUTPUT_DETAILS_KEYS = new Set(["thinking_tokens"]);

function collectUnknownKeys(obj: Record<string, unknown>, known: Set<string>, pathPrefix: string): string[] {
  return Object.keys(obj)
    .filter((k) => !known.has(k))
    .map((k) => (pathPrefix ? `${pathPrefix}.${k}` : k));
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// v2.6 §26：正規化層讀固定 key，廠商回傳形狀一變就靜默丟棄且不報錯——這個機制已生產
// 三個實例（thoughtsTokenCount、cachedContentTokenCount、cache_write_tokens）。本函式
// 偵測「為什麼會漏」，不是修「漏了哪個欄位」（那是 v2.5）。
//
// 規格一：只看 usageRaw（SendResult.usageRaw），不看整個 response——response 形狀多變
// 龐大，全面比對會製造大量無意義告警，而歷次漏讀全部發生在 usage 物件內。
// 規格三：只警告不阻斷，呼叫端自行處理失敗態（本函式對非物件輸入回傳空陣列，不丟例外，
// 讓「偵測器自身例外不得影響派工」的責任在呼叫端更容易兌現）。
// plan_dispatch_v2.7.md §29 規格七之二：providerKey 與 ProviderConfig.api 命名不同軸——
// "responses" 對應不變，"gemini-native" 併入 "gemini"，"anthropic-messages" 對應 "anthropic"。
export type UsageProviderKey = "responses" | "gemini" | "anthropic";

// 規格七之二：exhaustive 分派，不留「其餘落到 X」的預設分支——switch 缺少任一 case 時，
// TypeScript 會因「不是每條路徑都回傳值」而編譯失敗，逼未來新增第四家 provider 時必須
// 手動同步這裡，不會靜默落到既有某一家的允許清單（v2.6 的 unknownUsageProviderKey 三元
// 運算子正是這樣被 "anthropic-messages" 加入後靜默吃掉，型別檢查抓不到）。
export function usageProviderKeyFor(api: ProviderConfig["api"]): UsageProviderKey {
  switch (api) {
    case "responses":
      return "responses";
    case "gemini-native":
      return "gemini";
    case "anthropic-messages":
      return "anthropic";
  }
}

export function findUnknownUsageKeys(providerKey: UsageProviderKey, usageRaw: unknown): string[] {
  if (!isPlainRecord(usageRaw)) return [];

  if (providerKey === "responses") {
    const unknown = collectUnknownKeys(usageRaw, RESPONSES_USAGE_KEYS, "");
    if (isPlainRecord(usageRaw.input_tokens_details)) {
      unknown.push(...collectUnknownKeys(usageRaw.input_tokens_details, RESPONSES_INPUT_DETAILS_KEYS, "input_tokens_details"));
    }
    if (isPlainRecord(usageRaw.output_tokens_details)) {
      unknown.push(...collectUnknownKeys(usageRaw.output_tokens_details, RESPONSES_OUTPUT_DETAILS_KEYS, "output_tokens_details"));
    }
    return unknown;
  }

  if (providerKey === "anthropic") {
    const unknown = collectUnknownKeys(usageRaw, ANTHROPIC_USAGE_KEYS, "");
    if (isPlainRecord(usageRaw.cache_creation)) {
      unknown.push(...collectUnknownKeys(usageRaw.cache_creation, ANTHROPIC_CACHE_CREATION_KEYS, "cache_creation"));
    }
    if (isPlainRecord(usageRaw.output_tokens_details)) {
      unknown.push(...collectUnknownKeys(usageRaw.output_tokens_details, ANTHROPIC_OUTPUT_DETAILS_KEYS, "output_tokens_details"));
    }
    return unknown;
  }

  const unknown = collectUnknownKeys(usageRaw, GEMINI_USAGE_KEYS, "");
  if (Array.isArray(usageRaw.promptTokensDetails)) {
    for (const el of usageRaw.promptTokensDetails) {
      if (isPlainRecord(el)) {
        unknown.push(...collectUnknownKeys(el, GEMINI_PROMPT_DETAILS_ITEM_KEYS, "promptTokensDetails"));
      }
    }
  }
  return unknown;
}
