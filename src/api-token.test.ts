import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  findTokenIdForPresented,
  hasAnyActiveToken,
  issueToken,
  listTokens,
  revokeToken,
} from "./api-token.js";
import { openDb } from "./db.js";
import { DispatchError } from "./types.js";

function withDb(run: (db: ReturnType<typeof openDb>) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-api-token-"));
  try {
    run(openDb(path.join(root, "dowafu.db")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("api-token：issue 回傳明文，DB 只存 hash 不存明文", () => {
  withDb((db) => {
    const { id, plaintext } = issueToken(db, "laptop");
    const row = db.prepare("SELECT hash FROM tokens WHERE id = ?").get(id) as { hash: string };
    assert.notEqual(row.hash, plaintext);
    assert.equal(row.hash.length, 64); // sha256 hex
  });
});

test("api-token：verify 用正確明文找得到 id，錯誤明文找不到", () => {
  withDb((db) => {
    const { id, plaintext } = issueToken(db, "laptop");
    assert.equal(findTokenIdForPresented(db, plaintext), id);
    assert.equal(findTokenIdForPresented(db, plaintext + "x"), null);
    assert.equal(findTokenIdForPresented(db, undefined), null);
    assert.equal(findTokenIdForPresented(db, ""), null);
  });
});

test("api-token：比對實際呼叫 timingSafeEqual（鎖住 B-1 #3，非 ===）", (t) => {
  withDb((db) => {
    const { plaintext } = issueToken(db, "laptop");
    const spy = t.mock.method(crypto, "timingSafeEqual");
    findTokenIdForPresented(db, plaintext);
    assert.ok(spy.mock.calls.length > 0, "timingSafeEqual 應該被呼叫過");
  });
});

test("api-token：revoke 之後同一把 token 找不到（B-1 #4）", () => {
  withDb((db) => {
    const { id, plaintext } = issueToken(db, "laptop");
    revokeToken(db, id, "en");
    assert.equal(findTokenIdForPresented(db, plaintext), null);
  });
});

test("api-token：revoke 不存在或已撤銷的 id 講人話，不是 stack trace（B-1 #5）", () => {
  withDb((db) => {
    assert.throws(() => revokeToken(db, "no-such-id", "en"), (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.match(err.message, /no-such-id/);
      return true;
    });
    const { id } = issueToken(db, "laptop");
    revokeToken(db, id, "en");
    assert.throws(() => revokeToken(db, id, "en"), DispatchError);
  });
});

test("api-token：hasAnyActiveToken 反映目前未撤銷的 token 是否存在", () => {
  withDb((db) => {
    assert.equal(hasAnyActiveToken(db), false);
    const { id } = issueToken(db, "laptop");
    assert.equal(hasAnyActiveToken(db), true);
    revokeToken(db, id, "en");
    assert.equal(hasAnyActiveToken(db), false);
  });
});

test("api-token：list 依建立時間排序，含 label 與撤銷狀態", () => {
  withDb((db) => {
    const a = issueToken(db, "laptop");
    const b = issueToken(db);
    revokeToken(db, a.id, "en");
    const tokens = listTokens(db);
    assert.deepEqual(
      tokens.map((t) => t.id),
      [a.id, b.id],
    );
    assert.equal(tokens[0].label, "laptop");
    assert.notEqual(tokens[0].revoked_at, null);
    assert.equal(tokens[1].label, null);
    assert.equal(tokens[1].revoked_at, null);
  });
});
