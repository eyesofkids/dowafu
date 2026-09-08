import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCostUsd, estimateHardCapUsd, OUTPUT_TOKEN_CAP } from "./cost.js";
import type { ModelPricing, NormalizedUsage } from "./types.js";

const PRICING: ModelPricing = { inputPerM: 1.0, cachedInputPerM: 0.1, cacheWritePerM: 1.25, outputPerM: 5.0 };

function usage(overrides: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: true, ...overrides };
}

test("estimateCostUsd：無 pricing → null，不是 0", () => {
  assert.equal(estimateCostUsd(usage({ inputTokens: 1000 }), "responses", undefined), null);
});

test("estimateCostUsd：usage 不可用 → null", () => {
  assert.equal(estimateCostUsd(usage({ available: false, inputTokens: 1000 }), "responses", PRICING), null);
});

test("estimateCostUsd：無快取無推理的基本換算", () => {
  const u = usage({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(estimateCostUsd(u, "responses", PRICING), 1.0 + 5.0);
});

// §4 細節二：openai／deepseek（responses）的 cachedTokens 是 inputTokens 的子集，須扣掉
// 才是非快取價該計費的量，否則快取部分被重複計成原價。
test("estimateCostUsd：responses——cachedTokens 是 inputTokens 子集，計費時扣除重算", () => {
  const u = usage({ inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 400_000 });
  const cost = estimateCostUsd(u, "responses", PRICING);
  // 600k 非快取價（600k/1M*1.0=0.6）＋ 400k 快取價（400k/1M*0.1=0.04）
  assert.ok(cost !== null);
  assert.ok(Math.abs(cost! - (0.6 + 0.04)) < 1e-9);
});

// §4 細節二（反例）：anthropic 的 inputTokens 不含快取部分，不能再扣，四者並列相加。
test("estimateCostUsd：anthropic-messages——inputTokens 已排除快取，不可再扣", () => {
  const u = usage({ inputTokens: 600_000, outputTokens: 0, cachedTokens: 400_000 });
  const cost = estimateCostUsd(u, "anthropic-messages", PRICING);
  // 600k 全額原價（0.6）＋ 400k 快取價（0.04）——與上一則的 responses 結果數字相同，
  // 但推導方式不同（一個是扣減後計費，一個是本來就互斥），刻意用不同 provider 對照。
  assert.ok(cost !== null);
  assert.ok(Math.abs(cost! - (0.6 + 0.04)) < 1e-9);
});

// §4 細節一：gemini 的 reasoningTokens（thoughtsTokenCount）不是 outputTokens 的子集，
// 兩者都計費 output，須相加，不能只算 outputTokens。
test("estimateCostUsd：gemini-native——reasoningTokens 非 outputTokens 子集，output 計費須相加", () => {
  const u = usage({ inputTokens: 0, outputTokens: 500_000, reasoningTokens: 500_000 });
  const cost = estimateCostUsd(u, "gemini-native", PRICING);
  // (500k+500k)/1M * 5.0 = 5.0
  assert.ok(cost !== null);
  assert.ok(Math.abs(cost! - 5.0) < 1e-9);
});

// §4 細節一（反例）：openai／deepseek／anthropic 的 reasoning/thinking token 已含在
// outputTokens 裡，加了會重複計費。
test("estimateCostUsd：responses——reasoningTokens 已含在 outputTokens 內，不可再加", () => {
  const u = usage({ inputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 500_000 });
  const cost = estimateCostUsd(u, "responses", PRICING);
  // 只算 1M output，不是 1.5M——否則會是 7.5 而非 5.0
  assert.ok(cost !== null);
  assert.ok(Math.abs(cost! - 5.0) < 1e-9);
});

test("estimateCostUsd：anthropic-messages——thinking_tokens 已含在 outputTokens 內，不可再加", () => {
  const u = usage({ inputTokens: 0, outputTokens: 1_000_000, reasoningTokens: 500_000 });
  const cost = estimateCostUsd(u, "anthropic-messages", PRICING);
  assert.ok(cost !== null);
  assert.ok(Math.abs(cost! - 5.0) < 1e-9);
});

test("estimateCostUsd：cachedInputPerM／cacheWritePerM 缺席時退回 inputPerM（不折價，不是免費）", () => {
  const pricingNoDiscount: ModelPricing = { inputPerM: 2.0, outputPerM: 10.0 };
  const u = usage({ inputTokens: 1_000_000, cachedTokens: 1_000_000, outputTokens: 0 });
  const cost = estimateCostUsd(u, "anthropic-messages", pricingNoDiscount);
  // anthropic：inputTokens 與 cachedTokens 互斥並列，各 1M，皆用 inputPerM（無折價欄位）
  assert.ok(cost !== null);
  assert.ok(Math.abs(cost! - (2.0 + 2.0)) < 1e-9);
});

// 票 cost-cap §B-3 #1：缺價目資料時回傳 null，不是 0——與 estimateCostUsd 同一條規矩。
test("estimateHardCapUsd：無 pricing → null，不是 0", () => {
  assert.equal(estimateHardCapUsd(1_000, 20, undefined), null);
});

// §B-2：R = maxToolCalls + 1，用同一份公式在測試裡獨立算一次來對照，不對「$X.XX」這種
// 中間值斷言——中間值一變（天花板或 pricing 調整）測試就會誤紅，變異 #4 鎖的是「× R 這件事
// 有沒有做」，不是鎖死某個特定數字。
test("estimateHardCapUsd：R = maxToolCalls + 1，輪數線性影響上界（獨立公式對照，不斷言中間值字面量）", () => {
  const pricing: ModelPricing = { inputPerM: 0.44, outputPerM: 1.32 };
  const estimatedPromptTokens = 1_200;
  for (const maxToolCalls of [5, 20, 30]) {
    const rounds = maxToolCalls + 1;
    const expected =
      ((estimatedPromptTokens * rounds) / 1_000_000) * pricing.inputPerM +
      ((OUTPUT_TOKEN_CAP * rounds) / 1_000_000) * pricing.outputPerM;
    const actual = estimateHardCapUsd(estimatedPromptTokens, maxToolCalls, pricing);
    assert.ok(actual !== null);
    assert.ok(Math.abs(actual! - expected) < 1e-9, `maxToolCalls=${maxToolCalls}：期望 ${expected}，實際 ${actual}`);
  }
});

test("estimateHardCapUsd：maxToolCalls 越大，硬上限跟著變大（沒有寫死的中間值，§B-3 #3）", () => {
  const pricing: ModelPricing = { inputPerM: 0.44, outputPerM: 1.32 };
  const low = estimateHardCapUsd(1_200, 20, pricing);
  const high = estimateHardCapUsd(1_200, 30, pricing);
  assert.ok(low !== null && high !== null);
  assert.ok(high! > low!, "maxToolCalls 提高後，硬上限必須跟著變大");
});

test("estimateHardCapUsd：initial prompt 估算越大，硬上限跟著變大", () => {
  const pricing: ModelPricing = { inputPerM: 0.44, outputPerM: 1.32 };
  const small = estimateHardCapUsd(500, 20, pricing);
  const large = estimateHardCapUsd(5_000, 20, pricing);
  assert.ok(small !== null && large !== null);
  assert.ok(large! > small!);
});
