import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDb } from "./db.js";
import {
  buildKeyStatusRows,
  getProviderKey,
  listKnownProviderNames,
  listProviderKeys,
  maskTail,
  recordProviderKeyTest,
  removeProviderKey,
  setProviderKey,
} from "./provider-key.js";

function withDb(run: (db: ReturnType<typeof openDb>) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-provider-key-"));
  try {
    run(openDb(path.join(root, "dowafu.db")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// providers-store.ts 的 mergeProviders 需要完整 providers.json 形狀才能過驗證，本檔只需要
// `providers` 表裡有列——直接寫最小合法列，不繞經那整條解析路徑。
function seedProvider(db: ReturnType<typeof openDb>, name: string): void {
  db.prepare(
    `INSERT INTO providers (name, base_url, api, store, tool_calling, reasoning, updated_at)
     VALUES (?, 'https://example.invalid', 'responses', NULL, 1, '{}', '2020-01-01T00:00:00.000Z')`,
  ).run(name);
}

// A-2 #1：重複 set 同一個 provider 是更新不是新增一列

test("provider-key：set 同一個 provider 兩次是更新，不是新增一列", () => {
  withDb((db) => {
    seedProvider(db, "openai");
    setProviderKey(db, "openai", "first-value");
    const afterFirst = getProviderKey(db, "openai")!;
    setProviderKey(db, "openai", "second-value");
    const rows = listProviderKeys(db).filter((r) => r.provider === "openai");
    assert.equal(rows.length, 1, "同一個 provider 只能有一列");
    assert.equal(rows[0].apiKey, "second-value");
    assert.equal(rows[0].createdAt, afterFirst.createdAt, "created_at 不因更新而改變");
  });
});

// A-2 #3：rm 之後真的消失，不是標記刪除

test("provider-key：remove 之後 getProviderKey 找不到，DB 那列真的沒了", () => {
  withDb((db) => {
    seedProvider(db, "openai");
    setProviderKey(db, "openai", "sk-whatever");
    assert.equal(removeProviderKey(db, "openai"), true);
    assert.equal(getProviderKey(db, "openai"), undefined);
    assert.equal(db.prepare("SELECT count(*) AS c FROM provider_keys WHERE provider = ?").get("openai") && (db.prepare("SELECT count(*) AS c FROM provider_keys WHERE provider = ?").get("openai") as { c: number }).c, 0);
  });
});

test("provider-key：remove 不存在的 provider 回傳 false，不拋錯", () => {
  withDb((db) => {
    assert.equal(removeProviderKey(db, "nope"), false);
  });
});

// §C-1 之2：provider 清單從 DB 的 providers 表來

test("provider-key：listKnownProviderNames 從 providers 表取名單，依名稱排序", () => {
  withDb((db) => {
    seedProvider(db, "openai");
    seedProvider(db, "anthropic");
    seedProvider(db, "deepseek");
    assert.deepEqual(listKnownProviderNames(db), ["anthropic", "deepseek", "openai"]);
  });
});

// §E 點 3：遮罩尾碼只留最後 4 碼

test("provider-key：maskTail 只留最後 4 碼", () => {
  assert.equal(maskTail("sk-abcdef1234"), "…1234");
  assert.equal(maskTail("ab"), "…ab");
});

// §B 單一來源：0.5.0 起 DB 是 API key 的唯一來源（使用者裁示 2026-09-06）。
// 初版的三層優先序（ambient env > .env > DB）與 providerKeyEnvVar／resolveProviderKey
// 一併退場，連帶那五條「哪一層贏」的測試也不再有對應的行為可測。

test("provider-key：有設定 → getProviderKey 取得 DB 那把", () => {
  withDb((db) => {
    seedProvider(db, "openai");
    setProviderKey(db, "openai", "db-value");
    assert.equal(getProviderKey(db, "openai")?.apiKey, "db-value");
  });
});

test("provider-key：沒設定 → getProviderKey 回 undefined（派工據此中止）", () => {
  withDb((db) => {
    seedProvider(db, "openai");
    assert.equal(getProviderKey(db, "openai"), undefined);
  });
});

// buildKeyStatusRows：`dowafu key`／`key list`／`--doctor` 共用的判定，含遮罩尾碼與 DB 時間戳

test("provider-key：buildKeyStatusRows 對每個已知 provider 各一列，未設定者 maskedTail 為 null", () => {
  withDb((db) => {
    seedProvider(db, "openai");
    seedProvider(db, "gemini");
    setProviderKey(db, "openai", "sk-abcdef1234");
    const rows = buildKeyStatusRows(db);
    assert.equal(rows.length, 2);
    const openaiRow = rows.find((r) => r.provider === "openai")!;
    assert.equal(openaiRow.maskedTail, "…1234");
    assert.ok(openaiRow.updatedAt);
    assert.equal(openaiRow.lastTestSucceeded, null);
    const geminiRow = rows.find((r) => r.provider === "gemini")!;
    assert.equal(geminiRow.maskedTail, null);
    assert.equal(geminiRow.updatedAt, null);
    assert.equal(geminiRow.lastTestSucceeded, null);
  });
});

test("provider-key：recordProviderKeyTest 保留成功與失敗、型號與時間，不改 key 更新時間", () => {
  withDb((db) => {
    seedProvider(db, "openai");
    setProviderKey(db, "openai", "sk-abcdef1234");
    const before = getProviderKey(db, "openai")!;
    recordProviderKeyTest(db, "openai", "gpt-test", true);
    const passed = getProviderKey(db, "openai")!;
    assert.equal(passed.lastTestModel, "gpt-test");
    assert.equal(passed.lastTestSucceeded, true);
    assert.ok(passed.lastTestedAt);
    assert.equal(passed.updatedAt, before.updatedAt);
    recordProviderKeyTest(db, "openai", "gpt-test", false);
    const failed = getProviderKey(db, "openai")!;
    assert.equal(failed.lastTestSucceeded, false);
    assert.equal(failed.lastTestModel, "gpt-test");
  });
});

test("provider-key：換不同 key 清空測試三欄，重設同一把則保留", () => {
  withDb((db) => {
    seedProvider(db, "openai");
    setProviderKey(db, "openai", "first-key");
    recordProviderKeyTest(db, "openai", "gpt-test", true);
    const tested = getProviderKey(db, "openai")!;

    setProviderKey(db, "openai", "first-key");
    const sameKey = getProviderKey(db, "openai")!;
    assert.equal(sameKey.lastTestedAt, tested.lastTestedAt);
    assert.equal(sameKey.lastTestModel, "gpt-test");
    assert.equal(sameKey.lastTestSucceeded, true);

    setProviderKey(db, "openai", "replacement-key");
    const changedKey = getProviderKey(db, "openai")!;
    assert.equal(changedKey.lastTestedAt, null);
    assert.equal(changedKey.lastTestModel, null);
    assert.equal(changedKey.lastTestSucceeded, null);
  });
});

test("provider-key：buildKeyStatusRows 從不回傳明文本身（不變量 A-2 #2 的資料面前提）", () => {
  withDb((db) => {
    seedProvider(db, "openai");
    setProviderKey(db, "openai", "sk-super-secret-value-should-never-leak");
    const rows = buildKeyStatusRows(db);
    const serialized = JSON.stringify(rows);
    assert.doesNotMatch(serialized, /sk-super-secret/);
  });
});
