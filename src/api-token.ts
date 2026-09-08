// 工單 C §B：入站 HTTP 憑證的發／驗／撤銷。DB 只存 hash（見 db.ts 的 tokens 表註解），
// 明文只在 issueToken 呼叫當下回傳一次，之後任何地方都拿不回來。
//
// 與 provider API key（E12，下階段）刻意不共用任何機制：那把是要原樣交給廠商的，
// 這把只會被比對、不會被重放，兩者的儲存與比對語意相反。

// 具名匯入的 timingSafeEqual 在測試裡「換成 === 有沒有真的被鎖住」這件事上會失真——
// ESM 具名綁定在連結時就固定，t.mock.method 對 crypto 這個物件的屬性替換影響不到它。
// 改用 namespace import、呼叫端每次都經物件屬性查找，F-2 變異的偵測才踩得到。
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { now } from "./db.js";
import { m } from "./messages.js";
import { DispatchError, type Lang } from "./types.js";

export type ApiToken = {
  id: string;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
};

function hashToken(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
}

// B-1 #3：常數時間比對，長度不同直接回假（timingSafeEqual 對長度不同的 buffer 會拋）。
// 兩邊都是 sha256 hex（固定 64 字），這裡的長度守衛是防禦性的，不是本函式的主要工作——
// 主要工作是「用 timingSafeEqual 而不是 ===」，見 F-2 變異。
export function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// B-1 #2：明文只在這裡回傳一次，呼叫端（cli.ts 的 `token issue`）印出後即不再持有。
export function issueToken(db: DatabaseSync, label?: string): { id: string; plaintext: string } {
  const id = crypto.randomUUID();
  const plaintext = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO tokens (id, hash, label, created_at) VALUES (?, ?, ?, ?)").run(id, hashToken(plaintext), label ?? null, now());
  return { id, plaintext };
}

export function listTokens(db: DatabaseSync): ApiToken[] {
  return db.prepare("SELECT id, label, created_at, revoked_at FROM tokens ORDER BY created_at").all() as ApiToken[];
}

// B-1 #6：HTTP 起來卻一把 token 都沒發，端點活著但沒有任何請求進得來——這個查詢是那個
// 警告的資料來源，見 daemon.ts 的 serve()。
export function hasAnyActiveToken(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM tokens WHERE revoked_at IS NULL LIMIT 1").get() !== undefined;
}

// B-1 #4／#5：撤銷後同一把 token 即 401；撤銷不存在或已撤銷的 id 講人話，不分兩種訊息——
// 對呼叫者而言「這個 id 現在撤不動」是同一件事，沒有必要在措辭上分岔。
export function revokeToken(db: DatabaseSync, id: string, lang: Lang): void {
  const result = db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now(), id);
  if (result.changes === 0) throw new DispatchError(m(lang, "tokenNotFoundOrRevoked", id), 2);
}

// B-1 #1：比對，不回傳明文、不記值。找不到未撤銷的相符 token 回傳 null。
export function findTokenIdForPresented(db: DatabaseSync, presented: string | undefined): string | null {
  if (typeof presented !== "string" || presented.length === 0) return null;
  const presentedHash = hashToken(presented);
  const rows = db.prepare("SELECT id, hash FROM tokens WHERE revoked_at IS NULL").all() as Array<{ id: string; hash: string }>;
  const match = rows.find((row) => hashesMatch(row.hash, presentedHash));
  return match ? match.id : null;
}
