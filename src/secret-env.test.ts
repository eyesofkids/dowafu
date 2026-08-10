import { test } from "node:test";
import assert from "node:assert/strict";
import { SECRET_ENV_VARS } from "./secret-env.js";
import { registerSecrets, maskDeep } from "./mask.js";

// plan_dispatch_v2.7.md §29 規格三十第 6 條：本條擋的是本版唯一有安全後果的錯——
// registerSecrets 漏加 ANTHROPIC_API_KEY，金鑰就可能原樣出現在錯誤訊息、raw/*.request.json
// 或 run.jsonl 中而未被遮罩。用 SECRET_ENV_VARS（cli.ts 實際呼叫 registerSecrets 時用的
// 同一份清單）驅動 registerSecrets，模擬只有 ANTHROPIC_API_KEY 被設值的情境——若未來有人
// 從 SECRET_ENV_VARS 移除 "ANTHROPIC_API_KEY"，這則測試會變紅，而不是靜默通過。
test("SECRET_ENV_VARS 含 ANTHROPIC_API_KEY，且經 registerSecrets 後金鑰在錯誤訊息與 request 物件中皆被遮罩", () => {
  assert.ok(SECRET_ENV_VARS.includes("ANTHROPIC_API_KEY"), "漏加 ANTHROPIC_API_KEY 會導致金鑰洩漏（規格七）");

  const fakeKey = "sk-ant-test-fixture-9f3c7a1b2e4d";
  const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: fakeKey };
  registerSecrets(SECRET_ENV_VARS.map((k) => env[k]));
  try {
    const errorMessage = `Anthropic Messages API 401: invalid x-api-key ${fakeKey}`;
    const requestObj = { headers: { "x-api-key": fakeKey }, note: `key was ${fakeKey}` };

    const maskedMessage = maskDeep(errorMessage) as string;
    const maskedRequest = maskDeep(requestObj);

    assert.equal(maskedMessage.includes(fakeKey), false, "錯誤訊息中的金鑰須被遮罩");
    assert.equal(JSON.stringify(maskedRequest).includes(fakeKey), false, "request 物件中的金鑰須被遮罩");
  } finally {
    registerSecrets([]);
  }
});
