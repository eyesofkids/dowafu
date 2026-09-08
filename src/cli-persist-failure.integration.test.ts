import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { addSpoke, createTicket } from "./ticket-store.js";
import { m } from "./messages.js";
import { mergeProviders, readProvidersFile, setModelEnabled } from "./providers-store.js";
import { setProviderKey } from "./provider-key.js";

const CLI_ENTRY = fileURLToPath(new URL("./cli.ts", import.meta.url));

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", CLI_ENTRY, ...args], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

test("CLI：首度 DB 落檔失敗後重試，保留已付費 result 的 usage 與 costUsd", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cli-persist-failure-"));
  const server = createServer((req, res) => {
    assert.equal(req.url, "/v1/responses");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "fake-response-1",
      model: "fake-model",
      status: "completed",
      output: [{
        id: "msg-1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "paid report retained" }],
      }],
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
    }));
  });

  try {
    const address = await new Promise<{ port: number }>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server.address() as { port: number }));
    });
    const dbPath = path.join(root, "dowafu.db");
    const providersPath = path.join(root, "providers.json");
    mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
    writeFileSync(path.join(root, ".claude", "agents", "hole-finder-cost.md"), "測試用 agent 定義");
    writeFileSync(providersPath, JSON.stringify({
      formatVersion: 1,
      fake: {
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        api: "responses",
        store: false,
        toolCalling: false,
        reasoning: { style: "openai", allowed: ["low"], default: "low" },
        models: ["fake-model"],
        charsPerToken: 1,
        tpmLimit: null,
        maxSpokeTokens: null,
        pricing: { "fake-model": { inputPerM: 1_000_000, outputPerM: 1_000_000 } },
      },
    }));

    const db = openDb(dbPath);
    mergeProviders(db, await readProvidersFile(providersPath, "en"), false);
    setModelEnabled(db, "fake", "fake-model", true, "en");
    // 0.5.0 起 API key 只從 DB 讀（不再吃 FAKE_API_KEY 環境變數）。
    setProviderKey(db, "fake", "fake-key-local-only");
    createTicket(db, "sample", "# 待審段落\n內容\n", "zh");
    addSpoke(db, "sample", {
      agent: "hole-finder-cost",
      provider: "fake",
      model: "fake-model",
      effort: "low",
      body: "# 具體問題\n1. test\n\n# 允許讀取\n",
    }, "zh");
    db.exec("CREATE TABLE persist_fail_once (remaining INTEGER NOT NULL)");
    db.exec("INSERT INTO persist_fail_once VALUES (1)");
    db.exec(`CREATE TRIGGER fail_result_insert_once
      BEFORE INSERT ON results
      WHEN NEW.agent <> '__summary__' AND (SELECT remaining FROM persist_fail_once) = 1
      BEGIN
        UPDATE persist_fail_once SET remaining = 0;
        SELECT RAISE(FAIL, 'forced persist failure');
      END`);

    const run = await runCli(
      ["sample", "--db", dbPath, "--repo-root", root, "--yes"],
      { ...process.env, FAKE_API_KEY: "fake-key-local-only", DISPATCH_HOME: root },
    );

    assert.equal(run.code, 0, `stderr: ${run.stderr}`);
    // 斷言綁在訊息鍵上，不寫死字面量——措辭改了不該讓這條紅，但
    // 「這則錯誤有沒有被印出來」必須守住（D1-hot3：落檔失敗要留痕，不得靜默）。
    assert.ok(
      run.stderr.includes(m("en", "dbResultPersistenceFailed", "hole-finder-cost", "Error: forced persist failure")),
      `stderr: ${run.stderr}`,
    );
    const stored = db.prepare(
      "SELECT output, tokens_in, tokens_out, cost_usd FROM results WHERE job_id = ? AND agent = ?",
    ).get("sample", "hole-finder-cost") as {
      output: string;
      tokens_in: number;
      tokens_out: number;
      cost_usd: number;
    };
    assert.equal(stored.output, "paid report retained");
    assert.equal(stored.tokens_in, 11);
    assert.equal(stored.tokens_out, 7);
    assert.equal(stored.cost_usd, 18);
    assert.equal((db.prepare("SELECT remaining FROM persist_fail_once").get() as { remaining: number }).remaining, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
