import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDb } from "./db.js";
import { createProtocol } from "./mcp/protocol.js";
import { m } from "./messages.js";
import { recordProviderKeyTest, setProviderKey } from "./provider-key.js";

const CLI_PATH = path.join(process.cwd(), "src", "cli.ts");
const RAW_KEY = "sk-db-only-secret-not-for-output-1234";

function runCli(root: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
    encoding: "utf8",
    env: { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "en" },
  });
}

function toolText(protocol: ReturnType<typeof createProtocol>): string {
  const outcome = protocol.handleRpc({ id: 1, method: "tools/call", params: { name: "dispatch_tickets", arguments: {} } });
  assert.ok("response" in outcome);
  return ((outcome.response.result as { content: Array<{ text: string }> }).content[0]).text;
}

test("key visibility：零工單仍列 key 與 enabled model；四個輸出面皆不洩 DB 明文且中英不同", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-key-visibility-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    const db = openDb(dbPath, "en");
    for (const name of ["configured", "missing"]) {
      db.prepare(
        "INSERT INTO providers (name, base_url, api, store, tool_calling, reasoning, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(name, "https://example.invalid", "responses", 0, 1, JSON.stringify({ style: "openai", allowed: ["low"], default: "low" }), "2026-09-08T00:00:00.000Z");
    }
    db.prepare("INSERT INTO models (provider, model, enabled, updated_at) VALUES (?, ?, ?, ?)").run("configured", "enabled-model", 1, "2026-09-08T00:00:00.000Z");
    db.prepare("INSERT INTO models (provider, model, enabled, updated_at) VALUES (?, ?, ?, ?)").run("missing", "disabled-model", 0, "2026-09-08T00:00:00.000Z");
    setProviderKey(db, "configured", RAW_KEY);
    recordProviderKeyTest(db, "configured", "enabled-model", false);

    const keyList = runCli(root, ["key", "list", "--db", dbPath]);
    assert.equal(keyList.status, 0, keyList.stderr);
    const humanDoctor = runCli(root, ["--doctor", "--db", dbPath]);
    assert.equal(humanDoctor.status, 0, humanDoctor.stderr);
    const jsonDoctor = runCli(root, ["--doctor", "--json", "--db", dbPath]);
    assert.equal(jsonDoctor.status, 0, jsonDoctor.stderr);
    const englishMcp = toolText(createProtocol({ db, dbPath, lang: "en" }));
    const chineseMcp = toolText(createProtocol({ db, dbPath, lang: "zh" }));

    for (const output of [keyList.stdout, humanDoctor.stdout, jsonDoctor.stdout, englishMcp, chineseMcp]) {
      assert.doesNotMatch(output, new RegExp(RAW_KEY));
      assert.match(output, /…1234/);
      assert.match(output, /enabled-model/);
    }
    assert.match(keyList.stdout, /last test failed/);
    assert.match(humanDoctor.stdout, /last test failed/);
    assert.match(englishMcp, /No dispatchable DB tickets/);
    assert.match(englishMcp, /missing: ✗ not set/);
    assert.match(englishMcp, /Enabled model allowlist/);
    assert.match(chineseMcp, /沒有可派的 DB 工單/);
    assert.match(chineseMcp, /最近驗證失敗/);
    assert.notEqual(englishMcp, chineseMcp, "兩種語言不可固定回同一份英文訊息");

    const json = JSON.parse(jsonDoctor.stdout) as { apiKeys: Array<{ provider: string; lastTestSucceeded: boolean | null; maskedTail: string | null; lastTestModel: string | null }> };
    const configured = json.apiKeys.find((row) => row.provider === "configured");
    assert.equal(configured?.maskedTail, "…1234");
    assert.equal(configured?.lastTestModel, "enabled-model");
    assert.equal(configured?.lastTestSucceeded, false);
    assert.equal(json.apiKeys.find((row) => row.provider === "missing")?.lastTestSucceeded, null, "從未測過不可長成失敗");

    // A successful test belongs to the old key value.  After replacement every output
    // surface must show the new tail and the shared untested tri-state, never stale success.
    setProviderKey(db, "configured", "sk-replaced-key-not-yet-tested-5678");
    const replaced = runCli(root, ["key", "list", "--db", dbPath]);
    const replacedDoctor = runCli(root, ["--doctor", "--json", "--db", dbPath]);
    const replacedMcp = toolText(createProtocol({ db, dbPath, lang: "en" }));
    assert.match(replaced.stdout, /…5678/);
    assert.match(replaced.stdout, new RegExp(m("en", "keyStatusUntested")));
    assert.match(replacedDoctor.stdout, /…5678/);
    const replacedJson = JSON.parse(replacedDoctor.stdout) as { apiKeys: Array<{ provider: string; lastTestedAt: string | null; lastTestModel: string | null; lastTestSucceeded: boolean | null }> };
    const replacedKey = replacedJson.apiKeys.find((row) => row.provider === "configured");
    assert.equal(replacedKey?.lastTestedAt, null);
    assert.equal(replacedKey?.lastTestModel, null);
    assert.equal(replacedKey?.lastTestSucceeded, null);
    assert.match(replacedMcp, /…5678/);
    assert.match(replacedMcp, new RegExp(m("en", "keyStatusUntested")));
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
