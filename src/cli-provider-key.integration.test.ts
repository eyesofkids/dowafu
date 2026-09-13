// 熱修補（票 key-db 驗收）：API key 從 DB 讀取的**接線**測試，不是函式測試。
//
// 驗收時把 cli.ts 傳給 resolveSpokes 的 hasApiKey 回呼改成 `() => true`，524 條全綠——
// provider-key.test.ts 測的是「getProviderKey 給對值」，validate.test.ts 測的是「回呼回
// false 時會擋」，兩者都對，但都證明不了**派工時真的有人拿 DB 那張表去問**。
// 票 A 的 `enabled` 接線、cost-cap 的 gitignore 接線是同一型：函式對不代表有人在對的
// 時機叫它（v0_5_0/_archived/log.md §二，這個家族的第十次）。
//
// 兩條各鎖一端，因為 key 的解析有兩個呼叫點、失敗長得不一樣：
//   1. resolveSpokes 的 hasApiKey ——沒設定時要在付費之前就講人話中止
//   2. createAdapterFor 的 getProviderKey ——有設定時要真的拿到那把，不是回頭找環境變數
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { addSpoke, createTicket, sealTicket } from "./ticket-store.js";
import { m } from "./messages.js";
import { setProviderKey } from "./provider-key.js";
import { mergeProviders, readProvidersFile, setModelEnabled } from "./providers-store.js";

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

async function makeRoot(prefix: string, withKey: boolean): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  writeFileSync(path.join(root, ".claude", "agents", "hole-finder-cost.md"), "測試用 agent 定義");
  const providersPath = path.join(root, "providers.json");
  writeFileSync(providersPath, JSON.stringify(PROVIDERS));

  const db = openDb(path.join(root, "dowafu.db"), "en");
  mergeProviders(db, await readProvidersFile(providersPath, "en"), false);
  setModelEnabled(db, "fake", "fake-model", true, "en");
  if (withKey) setProviderKey(db, "fake", "test-key-abc123xyz");
  createTicket(db, "sample", "# 待審段落\n內容\n", "zh");
  addSpoke(db, "sample", {
    agent: "hole-finder-cost",
    provider: "fake",
    model: "fake-model",
    body: "# 具體問題\n1. 問題\n\n# 允許讀取\n",
  }, "zh");
  if (withKey) await sealTicket(db, "sample", root, "zh");
  db.close();
  return root;
}

// 環境變數刻意設成一個看起來像 key 的值：0.5.0 不讀它，所以這條測試在「DB 沒有」時
// 必須照樣中止——若哪天有人把環境變數那條路加回來，這條會變綠而失去意義，屆時它會先紅。
const ENV_DECOY = { FAKE_API_KEY: "env-value-must-not-be-used" };

test("CLI：DB 沒有該 provider 的 API key → 付費之前就中止，並指向 dowafu key", async () => {
  const root = await makeRoot("cli-key-missing-", false);
  try {
    const run = await runCli(
      ["sample", "--db", path.join(root, "dowafu.db"), "--repo-root", root, "--yes"],
      { ...process.env, ...ENV_DECOY, DISPATCH_HOME: root, DISPATCH_LANG: "en" },
    );
    assert.equal(run.code, 2, `應以 exit 2 中止，實際 ${run.code}；stderr：${run.stderr}`);
    assert.ok(
      run.stderr.includes(m("en", "apiKeyNotConfigured", "hole-finder-cost", "fake", "dowafu")),
      `stderr 應含「尚未設定 API key」並指向 dowafu key，實際：${run.stderr}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI：DB 有 API key → 通過齊備檢查，走到真正呼叫 provider 那一步（不是回頭找環境變數）", async () => {
  const root = await makeRoot("cli-key-present-", true);
  try {
    const run = await runCli(
      ["sample", "--db", path.join(root, "dowafu.db"), "--repo-root", root, "--yes"],
      { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "en" },
    );
    // baseURL 指向沒有 server 的 127.0.0.1:9，所以派工一定失敗（exit 4）——重點是**失敗的
    // 理由**：spoke 必須已經啟動並真的去連了，才證明 adapter 拿到了 DB 那把 key。
    // 用正面證據而不是「不是某某錯誤」：createAdapterFor 若改回讀 process.env（那裡沒有值），
    // 它會在 spoke 啟動前就拋 apiKeyMissing，這一行永遠不會出現。
    assert.ok(
      run.stdout.includes(m("en", "eventSpokeStart", "hole-finder-cost", "fake", "fake-model")),
      `spoke 應已啟動（代表 adapter 拿到 DB 的 key），實際 stdout：${run.stdout.slice(-600)}`,
    );
    assert.doesNotMatch(run.stdout, /Internal error: missing API key/, "不該落到型別窄化防禦");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// §C-3：`dowafu key` 的互動選單在非 TTY 下必須明確拒絕，不得掛住等一個永遠不會來的輸入。
// spawn 的 stdio "ignore" 天然就是非 TTY，正是 CI／管線會遇到的情境。
test("CLI：非 TTY 下跑互動的 dowafu key → 講人話中止，不掛住", async () => {
  const root = await makeRoot("cli-key-notty-", false);
  try {
    const run = await runCli(
      ["key", "--db", path.join(root, "dowafu.db")],
      { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "en" },
    );
    assert.equal(run.code, 2, `應以 exit 2 中止，實際 ${run.code}；stderr：${run.stderr}`);
    assert.ok(
      run.stderr.includes(m("en", "keyInteractiveRequiresTty")),
      `stderr 應說明需要互動終端機，實際：${run.stderr}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
