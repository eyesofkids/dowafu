import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "./db.js";
import { executeKeyTest } from "./cli.js";
import { getProviderKey, setProviderKey } from "./provider-key.js";

function seedTestableProvider(db: ReturnType<typeof openDb>): void {
  db.prepare(
    "INSERT INTO providers (name, base_url, api, store, tool_calling, reasoning, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("fake", "https://example.invalid", "responses", 0, 1, JSON.stringify({ style: "openai", allowed: ["low"], default: "low" }), "2026-09-08T00:00:00.000Z");
  db.prepare("INSERT INTO models (provider, model, enabled, updated_at) VALUES (?, ?, ?, ?)").run("fake", "fake-model", 1, "2026-09-08T00:00:00.000Z");
  setProviderKey(db, "fake", "test-only-key-1234");
}

test("key test：可注入 sender，成功與失敗都寫回同一把 DB key", async () => {
  const db = openDb(":memory:");
  seedTestableProvider(db);
  const success = await executeKeyTest(db, "fake", "en", async ({ model, apiKey }) => {
    assert.equal(model, "fake-model");
    assert.equal(apiKey, "test-only-key-1234");
  });
  assert.deepEqual(success, { model: "fake-model", succeeded: true });
  assert.equal(getProviderKey(db, "fake")?.lastTestSucceeded, true);

  const failed = await executeKeyTest(db, "fake", "en", async () => { throw new Error("injected failure"); });
  assert.equal(failed.succeeded, false);
  assert.equal(getProviderKey(db, "fake")?.lastTestSucceeded, false, "失敗不可遺漏寫回");
  assert.equal(getProviderKey(db, "fake")?.lastTestModel, "fake-model");
  db.close();
});
