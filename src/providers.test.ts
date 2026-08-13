import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProvidersFile, PROVIDERS_FORMAT_VERSION } from "./providers.js";
import { DispatchError } from "./types.js";
import { m } from "./messages.js";

// plan_dispatch_v1.8.md §5：reasoning.default 必填（當 allowed 非空時），且須在 allowed
// 內；models／charsPerToken 是本輪（實作順序第 2、3 項）新增欄位。純函式測試，不碰檔案系統
// （loadProviders() 的檔案讀取層已足夠簡單，不需另外測）。
//
// plan_dispatch_v1.10.md §24.3：新增 formatVersion 頂層欄位，載入時比對，不符即中止。
//
// plan_i18n_impl_tickets T4／plan_i18n_v1.2.md §5.5：parseProvidersFile 現在依 lang 產出
// 不同語言的訊息。訊息斷言改比對 m(lang, key, ...args) 重建出的期望值，理由同 ticket.test.ts
// 檔頭說明——這些都是一次性錯誤字串，不是格式斷言。
//
// hub 裁決（2026-08-12，同 ticket.test.ts／validate.test.ts 檔頭）：5 個 2 個以上同型
// （string）參數的 key（reasoningStyleInvalid／reasoningDefaultNotAllowed／
// pricingModelNotObject／providerApiInvalid／positiveNumberRequired）改用手寫字面量斷言，
// 不透過 m() 重建——m() 重建驗不到訊息模板自己的插值順序寫錯。其餘沿用 m() 重建。

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
  const parsed = parseProvidersFile(providersFile({ openai: baseProvider() }), "zh");
  assert.equal(parsed.openai.reasoning.default, "low");
  assert.deepEqual(parsed.openai.models, ["model-a"]);
  assert.equal(parsed.openai.charsPerToken, 1.0);
});

test("parseProvidersFile：allowed 非空但缺 default → 中止（不得回退到「不送參數」），訊息依 lang（zh／en）", () => {
  const raw = providersFile({ openai: baseProvider({ reasoning: { style: "openai", allowed: ["low", "high"] } }) });
  assert.throws(
    () => parseProvidersFile(raw, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, m("zh", "reasoningDefaultMissing", "openai"));
      return true;
    },
  );
  assert.throws(
    () => parseProvidersFile(raw, "en"),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, m("en", "reasoningDefaultMissing", "openai"));
      return true;
    },
  );
});

// reasoningDefaultNotAllowed [providerName, def, list]：3 個同型參數，手寫字面量斷言（hub 裁決）。
test("parseProvidersFile：default 不在 allowed 內 → 中止，訊息依 lang（zh／en，手寫字面量）", () => {
  const raw = providersFile({
    openai: baseProvider({ reasoning: { style: "openai", allowed: ["low", "high"], default: "medium" } }),
  });
  assert.throws(
    () => parseProvidersFile(raw, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, 'providers.json: openai.reasoning.default "medium" 不在 allowed 內（low, high）');
      return true;
    },
  );
  assert.throws(
    () => parseProvidersFile(raw, "en"),
    (err: unknown) => {
      assert.equal(
        (err as DispatchError).message,
        'providers.json: openai.reasoning.default "medium" is not in allowed (low, high)',
      );
      return true;
    },
  );
});

// allowed 為空陣列但 default 仍明填（providers.json 本身可以這樣寫，第一道
// 「allowed 非空時必填」檢查不會擋，因為 allowed 為空）時，走的是「不在 allowed 內」分支，
// list 顯示 emptyList（僅「（空）」二字）——與 validate.ts 的 emptyAllowedNote（較長說明句）
// 是不同 key，不要混用。
test("parseProvidersFile：allowed 為空陣列但 default 仍明填 → 不在 allowed 內，list 顯示 emptyList", () => {
  const raw = providersFile({
    openai: baseProvider({ reasoning: { style: "openai", allowed: [], default: "low" } }),
  });
  assert.throws(
    () => parseProvidersFile(raw, "zh"),
    (err: unknown) => {
      assert.equal(
        (err as DispatchError).message,
        m("zh", "reasoningDefaultNotAllowed", "openai", "low", m("zh", "emptyList")),
      );
      return true;
    },
  );
});

test("parseProvidersFile：allowed 為空陣列時 default 可以不存在（provider 尚未驗證、不可用）", () => {
  const parsed = parseProvidersFile(
    providersFile({ deepseek: baseProvider({ reasoning: { style: "deepseek", allowed: [] } }) }),
    "zh",
  );
  assert.equal(parsed.deepseek.reasoning.default, undefined);
});

// reasoningStyleInvalid [providerName, style]：2 個同型參數，手寫字面量斷言（hub 裁決）。
test("parseProvidersFile：reasoning.style 值不合法 → 中止，訊息依 lang（zh／en，手寫字面量）", () => {
  const raw = providersFile({
    openai: baseProvider({ reasoning: { style: "not-a-real-style", allowed: [] } }),
  });
  assert.throws(
    () => parseProvidersFile(raw, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, 'providers.json: openai.reasoning.style 值不合法："not-a-real-style"');
      return true;
    },
  );
  assert.throws(
    () => parseProvidersFile(raw, "en"),
    (err: unknown) => {
      assert.equal(
        (err as DispatchError).message,
        'providers.json: openai.reasoning.style is invalid: "not-a-real-style"',
      );
      return true;
    },
  );
});

test("parseProvidersFile：reasoning.default 非字串 → 中止，訊息依 lang（zh／en）", () => {
  const raw = providersFile({
    openai: baseProvider({ reasoning: { style: "openai", allowed: ["low"], default: 123 } }),
  });
  assert.throws(
    () => parseProvidersFile(raw, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, m("zh", "reasoningDefaultNotString", "openai"));
      return true;
    },
  );
  assert.throws(
    () => parseProvidersFile(raw, "en"),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, m("en", "reasoningDefaultNotString", "openai"));
      return true;
    },
  );
});

test("parseProvidersFile：models 未填時視為空陣列（不做型號檢查）", () => {
  const raw = baseProvider();
  delete (raw as Record<string, unknown>).models;
  const parsed = parseProvidersFile(providersFile({ openai: raw }), "zh");
  assert.deepEqual(parsed.openai.models, []);
});

test("parseProvidersFile：charsPerToken 未填時為 null（交給 CLI 全域值）", () => {
  const raw = baseProvider();
  delete (raw as Record<string, unknown>).charsPerToken;
  const parsed = parseProvidersFile(providersFile({ openai: raw }), "zh");
  assert.equal(parsed.openai.charsPerToken, null);
});

test("parseProvidersFile：charsPerToken 非正數 → 中止，訊息依 lang（zh／en）", () => {
  const raw = providersFile({ openai: baseProvider({ charsPerToken: 0 }) });
  assert.throws(
    () => parseProvidersFile(raw, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, m("zh", "providerCharsPerTokenInvalid", "openai"));
      return true;
    },
  );
  assert.throws(
    () => parseProvidersFile(raw, "en"),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, m("en", "providerCharsPerTokenInvalid", "openai"));
      return true;
    },
  );
});

test("parseProvidersFile：baseURL 缺失 → 中止，訊息依 lang（zh／en）", () => {
  const raw = providersFile({ openai: baseProvider({ baseURL: "" }) });
  assert.throws(
    () => parseProvidersFile(raw, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, m("zh", "providerBaseUrlMissing", "openai"));
      return true;
    },
  );
  assert.throws(
    () => parseProvidersFile(raw, "en"),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, m("en", "providerBaseUrlMissing", "openai"));
      return true;
    },
  );
});

test("parseProvidersFile：provider 的設定不是物件 → 中止，訊息依 lang（zh／en）", () => {
  const raw = providersFile({ openai: "not-an-object" });
  assert.throws(
    () => parseProvidersFile(raw, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, m("zh", "providerConfigNotObject", "openai"));
      return true;
    },
  );
  assert.throws(
    () => parseProvidersFile(raw, "en"),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, m("en", "providerConfigNotObject", "openai"));
      return true;
    },
  );
});

test("parseProvidersFile：store 為 true → 中止（違反設計原則 6），訊息依 lang（zh／en）", () => {
  const raw = providersFile({ openai: baseProvider({ store: true }) });
  assert.throws(
    () => parseProvidersFile(raw, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, m("zh", "providerStoreTrue", "openai"));
      return true;
    },
  );
  assert.throws(
    () => parseProvidersFile(raw, "en"),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, m("en", "providerStoreTrue", "openai"));
      return true;
    },
  );
});

test("parseProvidersFile：formatVersion 缺失 → 中止，訊息依 lang（zh／en）", () => {
  const raw = { openai: baseProvider() }; // 無 formatVersion
  assert.throws(
    () => parseProvidersFile(raw, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, m("zh", "providersFormatVersionMismatch", PROVIDERS_FORMAT_VERSION, "undefined"));
      return true;
    },
  );
  assert.throws(
    () => parseProvidersFile(raw, "en"),
    (err: unknown) => {
      assert.equal(
        (err as DispatchError).message,
        m("en", "providersFormatVersionMismatch", PROVIDERS_FORMAT_VERSION, "undefined"),
      );
      return true;
    },
  );
});

test("parseProvidersFile：formatVersion 不符（例如舊版留下的 providers.json）→ 中止，訊息依 lang（zh／en）", () => {
  const raw = { formatVersion: 999, openai: baseProvider() };
  assert.throws(
    () => parseProvidersFile(raw, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, m("zh", "providersFormatVersionMismatch", PROVIDERS_FORMAT_VERSION, "999"));
      return true;
    },
  );
  assert.throws(
    () => parseProvidersFile(raw, "en"),
    (err: unknown) => {
      assert.equal(
        (err as DispatchError).message,
        m("en", "providersFormatVersionMismatch", PROVIDERS_FORMAT_VERSION, "999"),
      );
      return true;
    },
  );
});

test("parseProvidersFile：providers.json 格式不是物件 → 中止，訊息依 lang（zh／en）", () => {
  assert.throws(
    () => parseProvidersFile(null, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, m("zh", "providersFileNotObject"));
      return true;
    },
  );
  assert.throws(
    () => parseProvidersFile(null, "en"),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, m("en", "providersFileNotObject"));
      return true;
    },
  );
});

test("parseProvidersFile：formatVersion 正確時，該欄位本身不會被誤判為 provider 設定", () => {
  const parsed = parseProvidersFile(providersFile({ openai: baseProvider() }), "zh");
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
    "zh",
  );
  assert.equal(parsed.anthropic.api, "anthropic-messages");
});

// providerApiInvalid [name, value]：2 個同型參數，手寫字面量斷言（hub 裁決）。
test("parseProvidersFile：api 為未知值（非 responses／gemini-native／anthropic-messages）→ 中止，訊息依 lang（zh／en，手寫字面量）", () => {
  const raw = providersFile({ mystery: baseProvider({ api: "some-future-api" }) });
  assert.throws(
    () => parseProvidersFile(raw, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(
        err.message,
        'providers.json: mystery.api 缺失或不合法（須為 "responses"、"gemini-native" 或 "anthropic-messages"），實際為 "some-future-api"',
      );
      return true;
    },
  );
  assert.throws(
    () => parseProvidersFile(raw, "en"),
    (err: unknown) => {
      assert.equal(
        (err as DispatchError).message,
        'providers.json: mystery.api is missing or invalid (must be "responses", "gemini-native", or "anthropic-messages"), got "some-future-api"',
      );
      return true;
    },
  );
});

// plan_fixes_v1.0.md §4：pricing 為選填欄位，缺席時 cost.ts 回傳 null（不強制每個
// provider 都要有價目）；有填就驗完整，格式錯即中止（fail closed）。
test("parseProvidersFile：未填 pricing 時 undefined（不強制成本估算）", () => {
  const parsed = parseProvidersFile(providersFile({ openai: baseProvider() }), "zh");
  assert.equal(parsed.openai.pricing, undefined);
});

test("parseProvidersFile：pricing 填完整欄位時正確解析（含選填的快取單價）", () => {
  const parsed = parseProvidersFile(
    providersFile({
      openai: baseProvider({
        pricing: { "model-a": { inputPerM: 0.2, cachedInputPerM: 0.02, outputPerM: 1.2 } },
      }),
    }),
    "zh",
  );
  assert.deepEqual(parsed.openai.pricing, { "model-a": { inputPerM: 0.2, cachedInputPerM: 0.02, outputPerM: 1.2 } });
});

test("parseProvidersFile：pricing 不是物件 → 中止，訊息依 lang（zh／en）", () => {
  const raw = providersFile({ openai: baseProvider({ pricing: "not-an-object" }) });
  assert.throws(
    () => parseProvidersFile(raw, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, m("zh", "pricingNotObject", "openai"));
      return true;
    },
  );
  assert.throws(
    () => parseProvidersFile(raw, "en"),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, m("en", "pricingNotObject", "openai"));
      return true;
    },
  );
});

// pricingModelNotObject [providerName, model]：2 個同型參數，手寫字面量斷言（hub 裁決）。
test("parseProvidersFile：pricing.<model> 不是物件 → 中止，訊息依 lang（zh／en，手寫字面量）", () => {
  const raw = providersFile({ openai: baseProvider({ pricing: { "model-a": "not-an-object" } }) });
  assert.throws(
    () => parseProvidersFile(raw, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, "providers.json: openai.pricing.model-a 不是物件");
      return true;
    },
  );
  assert.throws(
    () => parseProvidersFile(raw, "en"),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, "providers.json: openai.pricing.model-a is not an object");
      return true;
    },
  );
});

// positiveNumberRequired [label, value]：2 個同型參數，手寫字面量斷言（hub 裁決）。
test("parseProvidersFile：pricing 缺 inputPerM → 中止，訊息依 lang（zh／en，手寫字面量）", () => {
  const raw = providersFile({ openai: baseProvider({ pricing: { "model-a": { outputPerM: 1.2 } } }) });
  assert.throws(
    () => parseProvidersFile(raw, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, "providers.json: openai.pricing.model-a.inputPerM 須為正數，實際為 undefined");
      return true;
    },
  );
  assert.throws(
    () => parseProvidersFile(raw, "en"),
    (err: unknown) => {
      assert.equal(
        (err as DispatchError).message,
        "providers.json: openai.pricing.model-a.inputPerM must be a positive number, got undefined",
      );
      return true;
    },
  );
});

test("parseProvidersFile：pricing 單價為負數或零 → 中止，訊息依 lang（zh／en）——latencyMs 類的相鄰參數風險不適用於此", () => {
  const raw = providersFile({ openai: baseProvider({ pricing: { "model-a": { inputPerM: 0, outputPerM: 1.2 } } }) });
  assert.throws(
    () => parseProvidersFile(raw, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, m("zh", "positiveNumberRequired", "openai.pricing.model-a.inputPerM", "0"));
      return true;
    },
  );
  assert.throws(
    () => parseProvidersFile(raw, "en"),
    (err: unknown) => {
      assert.equal(
        (err as DispatchError).message,
        m("en", "positiveNumberRequired", "openai.pricing.model-a.inputPerM", "0"),
      );
      return true;
    },
  );
});
