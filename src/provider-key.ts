// 工單 key-db（E12）：provider 金鑰的 DB 存取。**DB 是唯一來源。**
//
// `provider_keys` 表由 T1（hub）建好（db.ts migration version 2），本檔不碰 schema。
// 與 src/api-token.ts 刻意不共用任何機制：那張表只存 hash（入站憑證，只比對不重放），
// 這裡存明文（出站，得原樣交給廠商）。方向相反，見票 §零之「⚠️ 命名」一節。
//
// **0.5.0 起不再從環境變數或 `$DISPATCH_HOME/.env` 讀 API key**（使用者裁示，2026-09-06）。
// 初版做過「ambient env > .env > DB」三層優先序，連帶要在 dotenv 載入當下記錄「哪些鍵是
// 我填的」才分辨得出來源，`--doctor` 也得逐層顯示。那整串複雜度是多來源自己養出來的
// ——**收緊成單一來源之後，優先序、來源分辨、各種組合的測試全部不存在**。
// 舊版把 key 放在 .env 的人，升級後請改用 `dowafu key` 重設一次；缺 key 的錯誤訊息會講。

import type { DatabaseSync } from "node:sqlite";
import { now } from "./db.js";

export type ProviderKeyRecord = {
  provider: string;
  apiKey: string;
  createdAt: string;
  updatedAt: string;
  lastTestedAt: string | null;
  lastTestModel: string | null;
  lastTestSucceeded: boolean | null;
};

type ProviderKeyDbRow = {
  provider: string;
  api_key: string;
  created_at: string;
  updated_at: string;
  last_tested_at: string | null;
  last_test_model: string | null;
  last_test_succeeded: number | null;
};

function toProviderKeyRecord(row: ProviderKeyDbRow): ProviderKeyRecord {
  return {
    provider: row.provider,
    apiKey: row.api_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTestedAt: row.last_tested_at,
    lastTestModel: row.last_test_model,
    lastTestSucceeded: row.last_test_succeeded === null ? null : row.last_test_succeeded === 1,
  };
}

export function getProviderKey(db: DatabaseSync, provider: string): ProviderKeyRecord | undefined {
  const row = db
    .prepare("SELECT provider, api_key, created_at, updated_at, last_tested_at, last_test_model, last_test_succeeded FROM provider_keys WHERE provider = ?")
    .get(provider) as ProviderKeyDbRow | undefined;
  return row ? toProviderKeyRecord(row) : undefined;
}

export function listProviderKeys(db: DatabaseSync): ProviderKeyRecord[] {
  return (
    db
      .prepare("SELECT provider, api_key, created_at, updated_at, last_tested_at, last_test_model, last_test_succeeded FROM provider_keys ORDER BY provider")
      .all() as ProviderKeyDbRow[]
  ).map(toProviderKeyRecord);
}

// A-2 #1：重複 set 同一個 provider 是更新不是新增一列，updated_at 要跟著動；created_at
// 只在第一次寫入時落地。呼叫端負責 trim；本檔不對內容做任何格式判斷（A-1：明文存、不驗證）。
export function setProviderKey(db: DatabaseSync, provider: string, apiKey: string): ProviderKeyRecord {
  const timestamp = now();
  db.prepare(
    `INSERT INTO provider_keys (provider, api_key, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       api_key = excluded.api_key,
       updated_at = excluded.updated_at,
       -- A test belongs to the key value, not merely its provider.  Re-pasting the same
       -- value keeps the result useful; a different value must return to the untested state.
       last_tested_at = CASE WHEN provider_keys.api_key <> excluded.api_key THEN NULL ELSE provider_keys.last_tested_at END,
       last_test_model = CASE WHEN provider_keys.api_key <> excluded.api_key THEN NULL ELSE provider_keys.last_test_model END,
       last_test_succeeded = CASE WHEN provider_keys.api_key <> excluded.api_key THEN NULL ELSE provider_keys.last_test_succeeded END`,
  ).run(provider, apiKey, timestamp, timestamp);
  return getProviderKey(db, provider)!;
}

// A-2 #3：真的刪掉那一列（不是標記刪除），回傳是否真的刪到東西。
export function removeProviderKey(db: DatabaseSync, provider: string): boolean {
  const result = db.prepare("DELETE FROM provider_keys WHERE provider = ?").run(provider);
  return Number(result.changes) > 0;
}

// key-visibility §B：不論 API 驗證成功或失敗都留下結果。這裡刻意不更新 updated_at：那欄
// 是 key 值最後被設定的時間，不能混進一個只讀驗證的時間。
export function recordProviderKeyTest(db: DatabaseSync, provider: string, model: string, succeeded: boolean): void {
  db.prepare(
    "UPDATE provider_keys SET last_tested_at = ?, last_test_model = ?, last_test_succeeded = ? WHERE provider = ?",
  ).run(now(), model, succeeded ? 1 : 0, provider);
}

// §C-1 之2：provider 清單從 DB 的 `providers` 表來（票 A 已把 provider 進 DB），不是硬編
// 一份四家的清單——新增 provider 時選單自動跟上。
export function listKnownProviderNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM providers ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
}

// 票 §E 點 3：遮罩尾碼會洩漏最後 4 碼——刻意的取捨（讓人認得出貼對沒），文件必須寫出來，
// 不是安全機制。
export function maskTail(apiKey: string): string {
  return `…${apiKey.slice(-4)}`;
}

export type KeyStatusRow = {
  provider: string;
  maskedTail: string | null; // null 代表這個 provider 還沒設定
  updatedAt: string | null;
  lastTestedAt: string | null;
  lastTestModel: string | null;
  lastTestSucceeded: boolean | null;
};

// `dowafu key`（互動選單）、`key list`、`--doctor` 三個輸出面共用同一份判定，避免各自
// 判斷一次而漂移。單一來源之後「有沒有設定」就等於 maskedTail 是不是 null，不需要來源欄位。
export function buildKeyStatusRows(db: DatabaseSync): KeyStatusRow[] {
  return listKnownProviderNames(db).map((provider) => {
    const stored = getProviderKey(db, provider);
    return {
      provider,
      maskedTail: stored ? maskTail(stored.apiKey) : null,
      updatedAt: stored ? stored.updatedAt : null,
      lastTestedAt: stored ? stored.lastTestedAt : null,
      lastTestModel: stored ? stored.lastTestModel : null,
      lastTestSucceeded: stored ? stored.lastTestSucceeded : null,
    };
  });
}
