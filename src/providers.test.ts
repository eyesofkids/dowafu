import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProvidersFile, PROVIDERS_FORMAT_VERSION } from "./providers.js";
import { DispatchError } from "./types.js";

// plan_dispatch_v1.8.md §5：reasoning.default 必填（當 allowed 非空時），且須在 allowed
// 內；models／charsPerToken 是本輪（實作順序第 2、3 項）新增欄位。純函式測試，不碰檔案系統
// （loadProviders() 的檔案讀取層已足夠簡單，不需另外測）。
//
// plan_dispatch_v1.10.md §24.3：新增 formatVersion 頂層欄位，載入時比對，不符即中止。

function baseProvider(overrides: Record<string, unknown> = {}) {
  return {
    baseURL: "https://example.test/v1",
    api: "responses",
    store: false,
    toolCalling: true,
    reasoning: { style: "openai", allowed: ["low", "high"], default: "low" },
    models: ["model-a"],
    charsPerToken: 1.0,
    tpmLimit: null,
    maxSpokeTokens: null,
    ...overrides,
  };
}

// 每個 providers.json 測試 fixture 都需要合法的 formatVersion——集中一處，測 formatVersion
// 本身的案例才手動組不帶它（或帶錯值）的物件。
function providersFile(entries: Record<string, unknown>) {
  return { formatVersion: PROVIDERS_FORMAT_VERSION, ...entries };
}

test("parseProvidersFile：完整合法設定通過，default/models/charsPerToken 皆解析出來", () => {
  const parsed = parseProvidersFile(providersFile({ openai: baseProvider() }));
  assert.equal(parsed.openai.reasoning.default, "low");
  assert.deepEqual(parsed.openai.models, ["model-a"]);
  assert.equal(parsed.openai.charsPerToken, 1.0);
});

test("parseProvidersFile：allowed 非空但缺 default → 中止（不得回退到「不送參數」）", () => {
  const raw = providersFile({ openai: baseProvider({ reasoning: { style: "openai", allowed: ["low", "high"] } }) });
  assert.throws(() => parseProvidersFile(raw), (err: unknown) => {
    assert.ok(err instanceof DispatchError);
    assert.match(err.message, /reasoning\.default 缺失/);
    return true;
  });
});

test("parseProvidersFile：default 不在 allowed 內 → 中止", () => {
  const raw = providersFile({
    openai: baseProvider({ reasoning: { style: "openai", allowed: ["low", "high"], default: "medium" } }),
  });
  assert.throws(() => parseProvidersFile(raw), (err: unknown) => {
    assert.ok(err instanceof DispatchError);
    assert.match(err.message, /不在 allowed 內/);
    return true;
  });
});

test("parseProvidersFile：allowed 為空陣列時 default 可以不存在（provider 尚未驗證、不可用）", () => {
  const parsed = parseProvidersFile(providersFile({
    deepseek: baseProvider({ reasoning: { style: "deepseek", allowed: [] } }),
  }));
  assert.equal(parsed.deepseek.reasoning.default, undefined);
});

test("parseProvidersFile：models 未填時視為空陣列（不做型號檢查）", () => {
  const raw = baseProvider();
  delete (raw as Record<string, unknown>).models;
  const parsed = parseProvidersFile(providersFile({ openai: raw }));
  assert.deepEqual(parsed.openai.models, []);
});

test("parseProvidersFile：charsPerToken 未填時為 null（交給 CLI 全域值）", () => {
  const raw = baseProvider();
  delete (raw as Record<string, unknown>).charsPerToken;
  const parsed = parseProvidersFile(providersFile({ openai: raw }));
  assert.equal(parsed.openai.charsPerToken, null);
});

test("parseProvidersFile：charsPerToken 非正數 → 中止", () => {
  const raw = providersFile({ openai: baseProvider({ charsPerToken: 0 }) });
  assert.throws(() => parseProvidersFile(raw), DispatchError);
});

test("parseProvidersFile：formatVersion 缺失 → 中止", () => {
  const raw = { openai: baseProvider() }; // 無 formatVersion
  assert.throws(() => parseProvidersFile(raw), (err: unknown) => {
    assert.ok(err instanceof DispatchError);
    assert.match(err.message, /formatVersion 不符/);
    return true;
  });
});

test("parseProvidersFile：formatVersion 不符（例如舊版留下的 providers.json）→ 中止", () => {
  const raw = { formatVersion: 999, openai: baseProvider() };
  assert.throws(() => parseProvidersFile(raw), (err: unknown) => {
    assert.ok(err instanceof DispatchError);
    assert.match(err.message, /formatVersion 不符/);
    return true;
  });
});

test("parseProvidersFile：formatVersion 正確時，該欄位本身不會被誤判為 provider 設定", () => {
  const parsed = parseProvidersFile(providersFile({ openai: baseProvider() }));
  assert.equal(Object.keys(parsed).includes("formatVersion"), false);
  assert.deepEqual(Object.keys(parsed), ["openai"]);
});

// plan_dispatch_v2.7.md §29 規格三十第 7 條：api:"anthropic-messages" 須能載入不報錯
// （新增第三個合法值），未知 api 值仍須中止——fallback 若沒拿掉，第四個誤植的值可能被
// 靜默接受（規格十）。
test("parseProvidersFile：api 為 anthropic-messages 通過", () => {
  const parsed = parseProvidersFile(
    providersFile({
      anthropic: baseProvider({
        api: "anthropic-messages",
        store: null,
        reasoning: { style: "anthropic", allowed: ["low", "high"], default: "high" },
      }),
    }),
  );
  assert.equal(parsed.anthropic.api, "anthropic-messages");
});

test("parseProvidersFile：api 為未知值（非 responses／gemini-native／anthropic-messages）→ 中止", () => {
  const raw = providersFile({ mystery: baseProvider({ api: "some-future-api" }) });
  assert.throws(() => parseProvidersFile(raw), (err: unknown) => {
    assert.ok(err instanceof DispatchError);
    assert.match(err.message, /api 缺失或不合法/);
    return true;
  });
});

// plan_fixes_v1.0.md §4：pricing 為選填欄位，缺席時 cost.ts 回傳 null（不強制每個
// provider 都要有價目）；有填就驗完整，格式錯即中止（fail closed）。
test("parseProvidersFile：未填 pricing 時 undefined（不強制成本估算）", () => {
  const parsed = parseProvidersFile(providersFile({ openai: baseProvider() }));
  assert.equal(parsed.openai.pricing, undefined);
});

test("parseProvidersFile：pricing 填完整欄位時正確解析（含選填的快取單價）", () => {
  const parsed = parseProvidersFile(
    providersFile({
      openai: baseProvider({
        pricing: { "model-a": { inputPerM: 0.2, cachedInputPerM: 0.02, outputPerM: 1.2 } },
      }),
    }),
  );
  assert.deepEqual(parsed.openai.pricing, { "model-a": { inputPerM: 0.2, cachedInputPerM: 0.02, outputPerM: 1.2 } });
});

test("parseProvidersFile：pricing 缺 inputPerM → 中止", () => {
  const raw = providersFile({ openai: baseProvider({ pricing: { "model-a": { outputPerM: 1.2 } } }) });
  assert.throws(() => parseProvidersFile(raw), (err: unknown) => {
    assert.ok(err instanceof DispatchError);
    assert.match(err.message, /inputPerM 須為正數/);
    return true;
  });
});

test("parseProvidersFile：pricing 單價為負數或零 → 中止", () => {
  const raw = providersFile({ openai: baseProvider({ pricing: { "model-a": { inputPerM: 0, outputPerM: 1.2 } } }) });
  assert.throws(() => parseProvidersFile(raw), (err: unknown) => {
    assert.ok(err instanceof DispatchError);
    assert.match(err.message, /inputPerM 須為正數/);
    return true;
  });
});
