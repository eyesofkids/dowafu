// plan_fixes_v1.0.md §4：成本用單價換算，不只給 token 數——實測 token 只差 18%，
// 依官方單價實算卻差 23.2 倍（單價本身差 10.7×〜26.8×）。只看 token 數會嚴重誤判
// 成本量級（issue_log_v2.3.md：外部 hub 依 token 判「gemini 貴 2.5 倍」，是這個誤判
// 的實例）。純函式，不做 I/O，供單元測試。
//
// 兩個必須處理的細節（§4）：
//
// 1. gemini 的 thoughtsTokenCount（正規化後的 reasoningTokens）不是 candidatesTokenCount
//    （outputTokens）的子集——官方帳目關係是 promptTokenCount + candidatesTokenCount +
//    thoughtsTokenCount = totalTokenCount（usage.ts 已驗證），且官方文件明文「Output
//    price (including thinking tokens)」，故兩者都要計費，outputTokens 之外要另加
//    reasoningTokens。openai／deepseek／anthropic 的 reasoning／thinking token 是
//    output 的子集，已經含在 outputTokens 裡，不可再加，否則重複計費。
//
// 2. anthropic 的 inputTokens 有快取時「不含」快取部分——cachedTokens（cache_read）與
//    cacheWriteTokens（cache_creation）是另外兩個獨立欄位，總量是四者之和（usage.ts
//    已驗證）。openai／deepseek／gemini 相反：cachedTokens／cacheWriteTokens 是
//    inputTokens 的子集（官方對「快取命中」的計費方式是「原生 input 價的一部分改用
//    快取價」），要從 inputTokens 扣掉才是「非快取價」該計費的量，否則會把快取部分
//    重複計成原價。

import type { ModelPricing, NormalizedUsage, ProviderConfig } from "./types.js";

// _docs/dispatch/v0_5_0/facts_output_cap.md §六：65,536（2^16）＝實測單輪 max 53,391
// （deepseek-v4-flash，96.6% 是 reasoning）加約 22% 餘裕，且遠高於 OpenAI 官方建議的
// 25,000 下限。四家 adapter 共用同一個常數（見 responses.ts／gemini-native.ts／
// anthropic-messages.ts），改一處三家跟著動——不得在各 adapter 各自寫死字面量。
export const OUTPUT_TOKEN_CAP = 65_536;

// 票 cost-cap §D：實測 75 次 spoke 級派工最多只跑到 15 輪（facts_output_cap.md §四），
// 降到 20 不影響任何一次既有派工；輪數對成本上界是線性的（estimateHardCapUsd）。
// 放在這裡（不放 cli-args.ts）是為了讓 ticket-store.ts 也能匯入而不與 cli-args.ts 互相
// 匯入成環——cli-args.ts 經 mcp/http.ts → mcp/protocol.ts 會匯回 ticket-store.ts。
export const DEFAULT_MAX_TOOL_CALLS = 20;

// exhaustive 對照表，缺一支會被 TypeScript 擋下——與 usage.ts 的 usageProviderKeyFor
// 同樣理由：不留「其餘」預設分支，逼新增第四家 provider 時必須手動同步。
const REASONING_INCLUDED_IN_OUTPUT: Record<ProviderConfig["api"], boolean> = {
  responses: true, // openai／deepseek：reasoning_tokens ⊆ output_tokens
  "gemini-native": false, // thoughtsTokenCount 與 candidatesTokenCount 是並列，非子集
  "anthropic-messages": true, // thinking_tokens ⊆ output_tokens
};

const CACHED_IS_SUBSET_OF_INPUT: Record<ProviderConfig["api"], boolean> = {
  responses: true,
  "gemini-native": true,
  "anthropic-messages": false, // input_tokens 已排除快取部分，四者並列相加
};

// pricing 缺席（該模型無價目資料）或 usage 不可用時回傳 null，不是 0——「無法估算」與
// 「估出來是零」必須可區分，否則報表會把「沒資料」誤讀成「免費」。
export function estimateCostUsd(
  usage: NormalizedUsage,
  api: ProviderConfig["api"],
  pricing: ModelPricing | undefined,
): number | null {
  if (!pricing) return null;
  if (!usage.available) return null;

  const cachedTokens = usage.cachedTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const reasoningTokens = usage.reasoningTokens ?? 0;

  const cachedIsSubset = CACHED_IS_SUBSET_OF_INPUT[api];
  const regularInputTokens = cachedIsSubset
    ? Math.max(0, usage.inputTokens - cachedTokens - cacheWriteTokens)
    : usage.inputTokens;

  const billableOutputTokens = REASONING_INCLUDED_IN_OUTPUT[api] ? usage.outputTokens : usage.outputTokens + reasoningTokens;

  const cachedPricePerM = pricing.cachedInputPerM ?? pricing.inputPerM;
  const cacheWritePricePerM = pricing.cacheWritePerM ?? pricing.inputPerM;

  return (
    (regularInputTokens / 1_000_000) * pricing.inputPerM +
    (cachedTokens / 1_000_000) * cachedPricePerM +
    (cacheWriteTokens / 1_000_000) * cacheWritePricePerM +
    (billableOutputTokens / 1_000_000) * pricing.outputPerM
  );
}

// 票 cost-cap §B：呼叫前的絕對上界，不是預測——與 estimateCostUsd（事後實算）互不相干，
// 不吃 usage。R = maxToolCalls + 1（最後一輪不呼叫 tool，見 §D／cli-args.ts）；
// 每輪都可能撞到 output 天花板，且最壞情況下每輪重送全部初始 prompt（無 cached 折扣）。
// 實測顯示這是實際花費的 20–30 倍（facts_output_cap.md §六）——那是上界的本質，不是算錯；
// 不得為了讓數字好看而調整這支算式，要調的是輪數上限（maxToolCalls）。
// 缺價目資料時回傳 null，不是 0——與 estimateCostUsd 同一條規矩（§4）。
export function estimateHardCapUsd(
  estimatedPromptTokens: number,
  maxToolCalls: number,
  pricing: ModelPricing | undefined,
): number | null {
  if (!pricing) return null;
  const rounds = maxToolCalls + 1;
  const outputCapTokens = OUTPUT_TOKEN_CAP * rounds;
  const inputCapTokens = estimatedPromptTokens * rounds;
  return (inputCapTokens / 1_000_000) * pricing.inputPerM + (outputCapTokens / 1_000_000) * pricing.outputPerM;
}
