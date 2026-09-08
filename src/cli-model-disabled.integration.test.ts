// 熱修補（票 A 驗收缺口一）：`enabled` 閘門的**接線**測試，不是函式測試。
//
// 驗收時把 cli.ts 傳給 resolveSpokes 的述詞拿掉，463 條測試全部照綠——
// validate.test.ts 測的是「給它一個回 false 的述詞，它會擋」，那證明不了
// 「派工時真的有人把 DB 的 enabled 接進去」。D2b 的啟動時 reap 是同一型：
// 函式對不代表有人在對的時機叫它（v0_5_0/_archived/log.md §六）。
//
// 故本測試走真的 CLI 子行程：DB 裡的型號被關掉之後，派工必須以 exit 6 中止。
// 型號在 addSpoke 當下是開的、之後才被關——那正是「只在撰寫時檢查」擋不住的情境。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", CLI_ENTRY, ...args], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const PROVIDERS = {
  formatVersion: 1,
  fake: {
    baseURL: "http://127.0.0.1:9/v1",
    api: "responses",
    store: false,
    toolCalling: true,
    reasoning: { style: "openai", allowed: ["low"], default: "low" },
    models: ["fake-model"],
    charsPerToken: 1.0,
    tpmLimit: null,
    maxSpokeTokens: null,
    pricing: { "fake-model": { inputPerM: 0.1, outputPerM: 0.2 } },
  },
};

test("CLI：工單建立後型號被停用，派工以 exit 6 中止（enabled 的接線）", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cli-model-disabled-"));
  try {
    mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
    writeFileSync(path.join(root, ".claude", "agents", "hole-finder-cost.md"), "測試用 agent 定義");
    const providersPath = path.join(root, "providers.json");
    writeFileSync(providersPath, JSON.stringify(PROVIDERS));

    const dbPath = path.join(root, "dowafu.db");
    const db = openDb(dbPath, "en");
    mergeProviders(db, await readProvidersFile(providersPath, "en"), false);
    // 撰寫時型號是開的——否則 addSpoke 自己就會擋下，測不到派工那一關。
    setModelEnabled(db, "fake", "fake-model", true, "en");
    // 0.5.0 起 API key 只從 DB 讀（不再吃 FAKE_API_KEY 環境變數）。
    setProviderKey(db, "fake", "fake-key-local-only");
    createTicket(db, "sample", "# 待審段落\n內容\n", "zh");
    addSpoke(db, "sample", {
      agent: "hole-finder-cost",
      provider: "fake",
      model: "fake-model",
      body: "# 具體問題\n1. 問題\n\n# 允許讀取\n",
    }, "zh");
    // 工單已存在，此刻才關掉——「只在撰寫時檢查」對這個情境完全無效。
    setModelEnabled(db, "fake", "fake-model", false, "en");
    db.close();

    const run = await runCli(
      ["sample", "--db", dbPath, "--repo-root", root, "--yes"],
      { ...process.env, FAKE_API_KEY: "fake-key-local-only", DISPATCH_HOME: root, DISPATCH_LANG: "en" },
    );

    assert.equal(run.code, 6, `派工應以 exit 6 中止，實際 ${run.code}；stderr：${run.stderr}`);
    assert.ok(
      run.stderr.includes(m("en", "modelDisabled", "fake-model", "dowafu")),
      `stderr 應含停用訊息，實際：${run.stderr}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
