import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  normalizeResponsesUsage,
  normalizeGeminiUsage,
  normalizeAnthropicUsage,
  normalizeFinishReason,
  sumUsage,
  findUnknownUsageKeys,
} from "./usage.js";

test("normalizeResponsesUsage：完整欄位（openai/deepseek /v1/responses 實測形狀）", () => {
  const raw = {
    input_tokens: 120,
    input_tokens_details: { cache_write_tokens: 0, cached_tokens: 10 },
    output_tokens: 37,
    output_tokens_details: { reasoning_tokens: 16 },
    total_tokens: 157,
  };
  const usage = normalizeResponsesUsage(raw);
  assert.deepEqual(usage, {
    inputTokens: 120,
    outputTokens: 37,
    totalTokens: 157,
    cachedTokens: 10,
    cacheWriteTokens: 0,
    reasoningTokens: 16,
    available: true,
  });
});

test("normalizeResponsesUsage：缺 total_tokens 時以 input+output 補（§12）", () => {
  const usage = normalizeResponsesUsage({ input_tokens: 100, output_tokens: 50 });
  assert.equal(usage.totalTokens, 150);
  assert.equal(usage.available, true);
});

test("normalizeResponsesUsage：input/output 都缺 → available:false", () => {
  const usage = normalizeResponsesUsage({});
  assert.equal(usage.available, false);
  assert.equal(usage.totalTokens, 0);
});

test("normalizeResponsesUsage：raw 為 null（usage 完全缺失）→ available:false", () => {
  const usage = normalizeResponsesUsage(null);
  assert.equal(usage.available, false);
});

test("normalizeGeminiUsage：完整欄位（generateContent 實測形狀）", () => {
  const usage = normalizeGeminiUsage({
    promptTokenCount: 77,
    candidatesTokenCount: 18,
    totalTokenCount: 95,
  });
  assert.deepEqual(usage.inputTokens, 77);
  assert.deepEqual(usage.outputTokens, 18);
  assert.deepEqual(usage.totalTokens, 95);
  assert.equal(usage.available, true);
});

test("normalizeGeminiUsage：缺 totalTokenCount 時以 input+output 補", () => {
  const usage = normalizeGeminiUsage({ promptTokenCount: 10, candidatesTokenCount: 5 });
  assert.equal(usage.totalTokens, 15);
  assert.equal(usage.available, true);
});

test("normalizeGeminiUsage：thoughtsTokenCount 抽成 reasoningTokens（v1.8 §5 開啟 thinkingConfig 後才會出現）", () => {
  const usage = normalizeGeminiUsage({
    promptTokenCount: 599,
    candidatesTokenCount: 49,
    totalTokenCount: 1000,
    thoughtsTokenCount: 352,
  });
  assert.equal(usage.reasoningTokens, 352);
  assert.equal(usage.totalTokens, 1000, "totalTokens 一律採 API 給值，不因 reasoningTokens 重算");
});

test("normalizeGeminiUsage：無 thoughtsTokenCount 時 reasoningTokens 為 undefined（未開推理的舊行為）", () => {
  const usage = normalizeGeminiUsage({ promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 });
  assert.equal(usage.reasoningTokens, undefined);
});

// plan_dispatch_v1.12.md §12／§14：核對真實外部派工的三輪 usageMetadata 原文（首次外部派工
// hole-finder-feasibility，facts_dispatch.md 2026-08-06「首次外部專案真實派工實測」），
// 確認 normalizeGeminiUsage 的輸出與原文帳目一致；另把 v1.9 未記錄的 promptTokensDetails
// 與 serviceTier 兩個欄位一併帶入，確保未來 gemini 加欄位時不會靜默壞掉（不參與計算，
// 也不應造成解析失敗）。
test("normalizeGeminiUsage：真實三輪 usageMetadata（首次外部派工，逐輪核對帳目）", () => {
  const round1 = normalizeGeminiUsage({
    promptTokenCount: 592,
    candidatesTokenCount: 79,
    totalTokenCount: 992,
    promptTokensDetails: [{ modality: "TEXT", tokenCount: 592 }],
    thoughtsTokenCount: 321,
    serviceTier: "standard",
  });
  assert.deepEqual(round1, {
    inputTokens: 592,
    outputTokens: 79,
    totalTokens: 992,
    reasoningTokens: 321,
    cachedTokens: undefined,
    available: true,
  });
  assert.equal(
    round1.inputTokens + round1.outputTokens + (round1.reasoningTokens ?? 0),
    round1.totalTokens,
    "帳目關係：promptTokenCount + candidatesTokenCount + thoughtsTokenCount = totalTokenCount",
  );

  const round2 = normalizeGeminiUsage({
    promptTokenCount: 1844,
    candidatesTokenCount: 100,
    totalTokenCount: 2136,
    promptTokensDetails: [{ modality: "TEXT", tokenCount: 1844 }],
    thoughtsTokenCount: 192,
    serviceTier: "standard",
  });
  assert.deepEqual(round2, {
    inputTokens: 1844,
    outputTokens: 100,
    totalTokens: 2136,
    reasoningTokens: 192,
    cachedTokens: undefined,
    available: true,
  });

  const round3 = normalizeGeminiUsage({
    promptTokenCount: 5673,
    candidatesTokenCount: 494,
    totalTokenCount: 6741,
    promptTokensDetails: [{ modality: "TEXT", tokenCount: 5673 }],
    thoughtsTokenCount: 574,
    serviceTier: "standard",
  });
  assert.deepEqual(round3, {
    inputTokens: 5673,
    outputTokens: 494,
    totalTokens: 6741,
    reasoningTokens: 574,
    cachedTokens: undefined,
    available: true,
  });
});

// gemini 的 thoughtsTokenCount 計入 totalTokenCount 但不計入 candidatesTokenCount（與
// openai／deepseek 的 reasoning_tokens ⊆ output_tokens 相反）。缺 totalTokenCount 時的
// 回補公式若沿用 input+output（子集假設下才成立），會在 thoughtsTokenCount 存在時漏算。
test("normalizeGeminiUsage：缺 totalTokenCount 但有 thoughtsTokenCount 時，回補須把推理 token 一併算入（非子集帳目）", () => {
  const usage = normalizeGeminiUsage({
    promptTokenCount: 592,
    candidatesTokenCount: 79,
    thoughtsTokenCount: 321,
  });
  assert.equal(usage.totalTokens, 992, "592 + 79 + 321，不能只補 592 + 79");
  assert.equal(usage.available, true);
});

test("normalizeFinishReason：completed 與 STOP 皆正規化為 stop，原始值保留於 finishReasonRaw", () => {
  assert.deepEqual(normalizeFinishReason("completed"), { finishReason: "stop", finishReasonRaw: "completed" });
  assert.deepEqual(normalizeFinishReason("STOP"), { finishReason: "stop", finishReasonRaw: "STOP" });
});

test("normalizeFinishReason：非 stop 值原樣保留", () => {
  assert.deepEqual(normalizeFinishReason("incomplete"), {
    finishReason: "incomplete",
    finishReasonRaw: "incomplete",
  });
});

test("normalizeFinishReason：null 正規化為 unknown", () => {
  assert.deepEqual(normalizeFinishReason(null), { finishReason: "unknown", finishReasonRaw: null });
});

// plan_dispatch_v2.5.md §25 測試 1：真實 gemini usageMetadata（某次派工的
// hole-finder-feasibility 第 8 輪，tmp/external-runs/<ticket>/raw/
// hole-finder-feasibility.response.json:321-339）。cachedContentTokenCount 一直在 raw 裡，
// 正規化層沒讀（issue_log_v2.1.md 2026-08-08）。
test("normalizeGeminiUsage：真實 cachedContentTokenCount 需被讀入 cachedTokens（v2.5 §24）", () => {
  const usage = normalizeGeminiUsage({
    promptTokenCount: 26773,
    candidatesTokenCount: 662,
    totalTokenCount: 27435,
    cachedContentTokenCount: 24468,
    promptTokensDetails: [{ modality: "TEXT", tokenCount: 26773 }],
    cacheTokensDetails: [{ modality: "TEXT", tokenCount: 24468 }],
    serviceTier: "standard",
  });
  assert.equal(usage.cachedTokens, 24468);
  assert.equal(usage.available, true, "快取欄位不得影響 available（v2.5 規格二）");
});

// plan_dispatch_v2.5.md §25 測試 2：真實 openai usage（某次派工的
// hole-finder-feasibility，tmp/external-runs/<ticket>/raw/
// hole-finder-feasibility.response.json:536-547）。cache_write_tokens 一直在 raw 裡，
// 既有測試（:13）帶了這個欄位卻沒斷言，漏讀不會變紅。
test("normalizeResponsesUsage：真實 cache_write_tokens 需被讀入 cacheWriteTokens（v2.5 §24）", () => {
  const usage = normalizeResponsesUsage({
    input_tokens: 41182,
    input_tokens_details: { cache_write_tokens: 37980, cached_tokens: 3199 },
    output_tokens: 3798,
    output_tokens_details: { reasoning_tokens: 1083 },
    total_tokens: 44980,
  });
  assert.equal(usage.cachedTokens, 3199);
  assert.equal(usage.cacheWriteTokens, 37980);
});

// plan_dispatch_v2.5.md §25 測試 3：不含任何快取欄位時，available 不得被拖累、cachedTokens
// 不得被 ?? 0 假造成 0——這正是 bug 藏兩個月的機制（規格二、三）。gemini 的 4,096 下限下
// 小 prompt 本來就沒有 cachedContentTokenCount（facts_dispatch.md 2026-08-08 更正條目二）。
test("usage 缺快取欄位時：available 不受影響，cachedTokens 維持 undefined 而非 0（v2.5 規格二、三）", () => {
  const gemini = normalizeGeminiUsage({
    promptTokenCount: 77,
    candidatesTokenCount: 18,
    totalTokenCount: 95,
  });
  assert.equal(gemini.available, true);
  assert.equal(gemini.cachedTokens, undefined);

  const responses = normalizeResponsesUsage({
    input_tokens: 120,
    output_tokens: 37,
    total_tokens: 157,
  });
  assert.equal(responses.available, true);
  assert.equal(responses.cachedTokens, undefined);
  assert.equal(responses.cacheWriteTokens, undefined);
});

test("sumUsage：累加各欄位；任一輪 available:false 則整體 available:false", () => {
  const a = { inputTokens: 10, outputTokens: 5, totalTokens: 15, available: true };
  const b = { inputTokens: 20, outputTokens: 10, totalTokens: 30, available: false };
  const sum = sumUsage(a, b);
  assert.equal(sum.inputTokens, 30);
  assert.equal(sum.totalTokens, 45);
  assert.equal(sum.available, false);
});

// v2.5 規格三：兩邊都沒有快取資料時，sumUsage 不得把「沒有資料」偽裝成「量測值為 0」。
test("sumUsage：cachedTokens／reasoningTokens 兩邊皆 undefined 時維持 undefined，任一邊有值才以 0 補另一邊", () => {
  const noCacheA = { inputTokens: 10, outputTokens: 5, totalTokens: 15, available: true };
  const noCacheB = { inputTokens: 20, outputTokens: 10, totalTokens: 30, available: true };
  const bothMissing = sumUsage(noCacheA, noCacheB);
  assert.equal(bothMissing.cachedTokens, undefined);
  assert.equal(bothMissing.reasoningTokens, undefined);

  const oneHasCache = { ...noCacheA, cachedTokens: 7, reasoningTokens: 3 };
  const mixed = sumUsage(oneHasCache, noCacheB);
  assert.equal(mixed.cachedTokens, 7, "另一邊缺席時以 0 補，不是整體變 undefined");
  assert.equal(mixed.reasoningTokens, 3);
});

// plan_dispatch_v2.6.md §28 測試 1：未知 key 須被偵測到，路徑用點記法標明巢狀位置。
test("findUnknownUsageKeys：頂層未知 key 需被偵測，回傳點記法路徑（v2.6 §28 測試 1）", () => {
  const keys = findUnknownUsageKeys("responses", {
    input_tokens: 100,
    output_tokens: 50,
    total_tokens: 150,
    brand_new_field: 999,
  });
  assert.deepEqual(keys, ["brand_new_field"]);
});

// §28 測試 2：全部已知 key → 空陣列，不誤報。含 v2.5 剛讀進來的 cachedContentTokenCount／
// cache_write_tokens，以及規格二明文要求列入允許清單的 cacheTokensDetails／
// image_tokens／text_tokens（見 usage.ts 允許清單旁註）。
test("findUnknownUsageKeys：全部已知 key（含 v2.5 新讀欄位）→ 空陣列，不誤報（v2.6 §28 測試 2）", () => {
  const responsesKeys = findUnknownUsageKeys("responses", {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 },
    output_tokens: 50,
    output_tokens_details: { reasoning_tokens: 16 },
    total_tokens: 150,
  });
  assert.deepEqual(responsesKeys, []);

  const geminiKeys = findUnknownUsageKeys("gemini", {
    promptTokenCount: 100,
    candidatesTokenCount: 50,
    totalTokenCount: 150,
    thoughtsTokenCount: 20,
    cachedContentTokenCount: 30,
    promptTokensDetails: [{ modality: "TEXT", tokenCount: 100 }],
    cacheTokensDetails: [{ modality: "TEXT", tokenCount: 30 }],
    serviceTier: "standard",
  });
  assert.deepEqual(geminiKeys, []);
});

// §28 測試 3：巢狀未知 key，路徑須含父節點名，不能只回 key 名。
test("findUnknownUsageKeys：巢狀未知 key 的路徑含父節點名（v2.6 §28 測試 3）", () => {
  const keys = findUnknownUsageKeys("responses", {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 10, brand_new_nested: 1 },
    output_tokens: 50,
    total_tokens: 150,
  });
  assert.deepEqual(keys, ["input_tokens_details.brand_new_nested"]);
});

// §28 測試 5：usageRaw 為 null／非物件 → 空陣列，不丟例外（規格六）。
test("findUnknownUsageKeys：usageRaw 為 null 或非物件時回傳空陣列且不丟例外（v2.6 §28 測試 5）", () => {
  assert.deepEqual(findUnknownUsageKeys("responses", null), []);
  assert.deepEqual(findUnknownUsageKeys("gemini", null), []);
  assert.deepEqual(findUnknownUsageKeys("responses", "not an object"), []);
  assert.deepEqual(findUnknownUsageKeys("responses", 42), []);
  assert.deepEqual(findUnknownUsageKeys("responses", undefined), []);
});

// plan_dispatch_v2.6.md §27：本版驗收的重點不是「現在跑不出來就算過」——v2.5（b422aa4）
// 已經把這兩個欄位讀進允許清單，直接對這兩筆 fixture 跑現在的 findUnknownUsageKeys 只會
// 得到空陣列，證明不了機制本身有效。這裡刻意重建 v2.5 之前（b422aa4 之前）usage.ts 認得
// 的允許清單，對同一組真實 raw（與 §25 測試 1、2 同一來源）重跑，證明「這個機制若兩個月
// 前就存在，v2.5 修的兩個漏讀 2026-08-08 當天就會被叫出來」——這是本版唯一有意義的驗收
// 標準（§27 原文）。
test("§27：用 v2.5 之前的舊允許清單重跑真實 raw，證明機制當年就會叫出這兩個真實發生過的漏讀", () => {
  const OLD_GEMINI_USAGE_KEYS = new Set([
    "promptTokenCount",
    "candidatesTokenCount",
    "totalTokenCount",
    "thoughtsTokenCount",
    // v2.5 之前：cachedContentTokenCount 尚未讀入，不在允許清單內
  ]);
  const OLD_RESPONSES_INPUT_DETAILS_KEYS = new Set([
    "cached_tokens",
    // v2.5 之前：cache_write_tokens 尚未讀入，不在允許清單內
  ]);

  function oldFindUnknownTopLevel(known: Set<string>, obj: Record<string, unknown>): string[] {
    return Object.keys(obj).filter((k) => !known.has(k));
  }

  // 與 §25 測試 1 同一份真實 gemini raw（第 8 輪，tmp/external-runs/<ticket>/
  // raw/hole-finder-feasibility.response.json:321-339）
  const geminiRaw = {
    promptTokenCount: 26773,
    candidatesTokenCount: 662,
    totalTokenCount: 27435,
    cachedContentTokenCount: 24468,
  };
  const geminiUnknown = oldFindUnknownTopLevel(OLD_GEMINI_USAGE_KEYS, geminiRaw);
  assert.deepEqual(geminiUnknown, ["cachedContentTokenCount"], "舊允許清單應叫出這個當年被漏掉的欄位");

  // 與 §25 測試 2 同一份真實 openai raw（tmp/external-runs/<ticket>/
  // raw/hole-finder-feasibility.response.json:536-547）
  const openaiInputDetails = { cache_write_tokens: 37980, cached_tokens: 3199 };
  const openaiUnknown = oldFindUnknownTopLevel(OLD_RESPONSES_INPUT_DETAILS_KEYS, openaiInputDetails);
  assert.deepEqual(openaiUnknown, ["cache_write_tokens"], "舊允許清單應叫出這個當年被漏掉的欄位");
});

// plan_dispatch_v2.6.md §28 測試 4：這組測試裡最有價值的一條——用十次真實派工的 raw
// 全跑，斷言「目前」允許清單零誤報。允許清單漏列任何既有欄位都會讓這條變紅，是防止
// 允許清單悄悄過期的唯一防線。直接讀 tmp/external-runs/ 的真實檔案（不是寫死快照），
// 這樣往後新增真實派工樣本時，這條測試會自動核對到新資料，而不是永遠只核對寫測試當下
// 的凍結片段。
// fixture 是十次真實派工的 raw 裡**只有 usage／usageMetadata 物件**的那一部分——那些只含
// token 數字與欄位名，沒有任何被審專案的內容，所以進得了版控。原始 raw 留在上游（`tmp/`），
// 下面第二段會在它存在時一併核對，新樣本進來時仍然自動涵蓋。
type UsageFixtureEntry = { api: "responses" | "gemini"; usage: unknown };

test("findUnknownUsageKeys：十次真實派工的 usage 全跑，目前允許清單零誤報（v2.6 §27／§28 測試 4）", () => {
  const fixtureDir = path.resolve(import.meta.dirname, "__fixtures__", "usage");
  const fixtures = readdirSync(fixtureDir).filter((f) => f.endsWith(".json"));
  assert.ok(fixtures.length >= 10, `預期至少 10 份派工的 usage fixture，實際 ${fixtures.length}`);

  const allUnknown: { file: string; index: number; keys: string[] }[] = [];
  let checkedRounds = 0;

  for (const file of fixtures) {
    const entries = JSON.parse(readFileSync(path.join(fixtureDir, file), "utf8")) as UsageFixtureEntry[];
    entries.forEach((entry, index) => {
      checkedRounds++;
      const keys = findUnknownUsageKeys(entry.api, entry.usage);
      if (keys.length > 0) allUnknown.push({ file, index, keys });
    });
  }

  // 上游若還留著原始產物，連同新樣本一起核對——這一段在只有 fixture 的環境不執行，
  // 但 fixture 那一段永遠會跑，所以不存在「整條測試靜默不驗」的狀態。
  const externalRunsDir = path.resolve(import.meta.dirname, "..", "tmp", "external-runs");
  let ticketDirs: string[];
  try {
    ticketDirs = readdirSync(externalRunsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    ticketDirs = [];
  }

  for (const ticket of ticketDirs) {
    const rawDir = path.join(externalRunsDir, ticket, "raw");
    let files: string[];
    try {
      files = readdirSync(rawDir).filter((f) => f.endsWith(".response.json"));
    } catch {
      continue;
    }
    for (const file of files) {
      const fullPath = path.join(rawDir, file);
      const data = JSON.parse(readFileSync(fullPath, "utf8"));
      const items = Array.isArray(data) ? data : [data];
      items.forEach((item, index) => {
        if (!item || typeof item !== "object") return;
        if ("usage" in item) {
          checkedRounds++;
          const keys = findUnknownUsageKeys("responses", (item as Record<string, unknown>).usage);
          if (keys.length > 0) allUnknown.push({ file: `${ticket}/raw/${file}`, index, keys });
        }
        if ("usageMetadata" in item) {
          checkedRounds++;
          const keys = findUnknownUsageKeys("gemini", (item as Record<string, unknown>).usageMetadata);
          if (keys.length > 0) allUnknown.push({ file: `${ticket}/raw/${file}`, index, keys });
        }
      });
    }
  }

  assert.ok(checkedRounds > 0, "應至少檢查到一輪真實 usage，否則這條測試在測空氣");
  assert.deepEqual(allUnknown, [], `允許清單對現有樣本應零誤報，實際誤報：${JSON.stringify(allUnknown)}`);
});

// plan_dispatch_v2.7.md §29 規格三十第 4 條：total_tokens 不存在，須自行加總四個欄位——
// 算錯會讓成本與門檻全部失真，這是本版核心測試之一。
test("normalizeAnthropicUsage：帶四個 token 欄位，totalTokens 為四者之和（無 total_tokens 可讀）", () => {
  const raw = {
    input_tokens: 126,
    output_tokens: 520,
    cache_creation_input_tokens: 4622,
    cache_read_input_tokens: 4622,
    output_tokens_details: { thinking_tokens: 49 },
  };
  const usage = normalizeAnthropicUsage(raw);
  assert.equal(usage.totalTokens, 126 + 520 + 4622 + 4622, "totalTokens 須為 input+output+cache_read+cache_creation 四者之和，不是只有 input+output");
  assert.equal(usage.inputTokens, 126);
  assert.equal(usage.outputTokens, 520);
  assert.equal(usage.cachedTokens, 4622);
  assert.equal(usage.cacheWriteTokens, 4622);
  assert.equal(usage.reasoningTokens, 49);
  assert.equal(usage.available, true);
});

// 規格三十第 5 條：無快取欄位時 available 不受影響（沿用 v2.5 規格二、三），快取欄位維持
// undefined 而非 0——「沒有資料」與「量測值為 0」須可區分。
test("normalizeAnthropicUsage：無快取欄位的 usage → available 為 true，快取欄位為 undefined", () => {
  const raw = { input_tokens: 10, output_tokens: 5 };
  const usage = normalizeAnthropicUsage(raw);
  assert.equal(usage.available, true);
  assert.equal(usage.cachedTokens, undefined);
  assert.equal(usage.cacheWriteTokens, undefined);
  assert.equal(usage.totalTokens, 15);
});

test("normalizeFinishReason：anthropic 的 end_turn 正規化為 stop，tool_use 不算 stop（規格十）", () => {
  assert.equal(normalizeFinishReason("end_turn").finishReason, "stop");
  assert.equal(normalizeFinishReason("tool_use").finishReason, "tool_use", "tool_use 是要繼續的訊號，不得正規化為 stop");
});

// 規格三十第 8 條：真實 anthropic usage（scripts/verify-providers.ts 對真實 API 實測，見
// facts_dispatch.md 2026-08-08 條目）餵入偵測器須為空陣列——沒加 ANTHROPIC_USAGE_KEYS，
// 或 anthropic 被路由到 gemini 的允許清單，都會讓每個欄位被誤報成未知（規格七之二）。
test("findUnknownUsageKeys：真實 anthropic usage（cache_control 實測回應）→ 空陣列", () => {
  const realUsage = {
    input_tokens: 2,
    cache_creation_input_tokens: 4622,
    cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 4622, ephemeral_1h_input_tokens: 0 },
    output_tokens: 64,
    output_tokens_details: { thinking_tokens: 0 },
    service_tier: "standard",
    inference_geo: "global",
  };
  assert.deepEqual(findUnknownUsageKeys("anthropic", realUsage), []);
});

test("findUnknownUsageKeys：anthropic 頂層與巢狀未知 key 皆被偵測", () => {
  const keys = findUnknownUsageKeys("anthropic", {
    input_tokens: 1,
    output_tokens: 1,
    brand_new_top_level_field: 1,
    cache_creation: { ephemeral_5m_input_tokens: 1, brand_new_nested_field: 1 },
  });
  assert.deepEqual(keys.sort(), ["brand_new_top_level_field", "cache_creation.brand_new_nested_field"].sort());
});
