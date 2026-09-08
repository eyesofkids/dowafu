// 熱修補（票 cost-cap 驗收，缺口一）：gitignore 檢查的**接線**測試，不是函式測試。
//
// 驗收時把 cli.ts 的 `checkGitignore(resolvedDbPath)` 改回寫死 `"unknown"`，518 條測試
// 全部照綠——gitignore-check.test.ts 測的是「給它一條路徑，它會判定」，那證明不了
// 「派工時真的有人拿**資料庫檔案的路徑**去問」。票 A 的 `enabled` 接線（拿掉後 463 全綠）、
// D2b 的啟動時 reap 是同一型：函式對不代表有人在對的時機叫它（v0_5_0/_archived/log.md §二）。
//
// 本測試走真的 CLI 子行程，在一個 temp git repo 內乾跑（不呼叫任何 API、不花錢），
// 從 `--json` 的 `gitignoreStatus` 讀回判定結果。**兩種情形必須給出不同的答案**——
// 只斷言「不是 unknown」的話，一個永遠回 not_ignored 的假實作也會過。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { addSpoke, createTicket } from "./ticket-store.js";
import { mergeProviders, readProvidersFile, setModelEnabled } from "./providers-store.js";
import { setProviderKey } from "./provider-key.js";

const CLI_ENTRY = fileURLToPath(new URL("./cli.ts", import.meta.url));

// 與其他 integration test 的 helper 差別只有一處：cwd 要能傳進來。checkGitignore 以
// process.cwd() 為判定基準（gitignore-check.ts 的註解說明了為什麼不接受其他基準），
// 所以子行程必須真的跑在那個 temp repo 裡面，否則問的是本專案的 repo。
function runCli(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", CLI_ENTRY, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
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

// 回傳乾跑 JSON 的 gitignoreStatus。`--json` 下 stdout 只有那一個物件
// （人類可讀輸出全部改走 stderr，見 cli.ts 的 makeLogger）。
async function dryRunGitignoreStatus(root: string): Promise<string> {
  const dbPath = path.join(root, "dowafu.db");
  const run = await runCli(
    ["sample", "--db", dbPath, "--repo-root", root, "--dry-run", "--json"],
    { ...process.env, FAKE_API_KEY: "fake-key-local-only", DISPATCH_HOME: root, DISPATCH_LANG: "en" },
    root,
  );
  assert.equal(run.code, 0, `乾跑應成功，實際 ${run.code}；stderr：${run.stderr}`);
  const payload = JSON.parse(run.stdout) as { gitignoreStatus: string };
  return payload.gitignoreStatus;
}

async function makeRepo(prefix: string): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const init = spawnSync("git", ["init", "-q"], { cwd: root });
  assert.equal(init.status, 0, `git init 失敗：${init.stderr?.toString()}`);

  mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
  writeFileSync(path.join(root, ".claude", "agents", "hole-finder-cost.md"), "測試用 agent 定義");
  const providersPath = path.join(root, "providers.json");
  writeFileSync(providersPath, JSON.stringify(PROVIDERS));

  const db = openDb(path.join(root, "dowafu.db"), "en");
  mergeProviders(db, await readProvidersFile(providersPath, "en"), false);
  setModelEnabled(db, "fake", "fake-model", true, "en");
  setProviderKey(db, "fake", "fake-key-local-only");
  createTicket(db, "sample", "# 待審段落\n內容\n", "zh");
  addSpoke(db, "sample", {
    agent: "hole-finder-cost",
    provider: "fake",
    model: "fake-model",
    body: "# 具體問題\n1. 問題\n\n# 允許讀取\n",
  }, "zh");
  db.close();
  return root;
}

test("CLI：資料庫檔案未被 .gitignore 涵蓋時，乾跑報告 not_ignored（gitignore 檢查的接線）", async () => {
  const root = await makeRepo("cli-gitignore-db-not-");
  try {
    assert.equal(await dryRunGitignoreStatus(root), "not_ignored");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI：資料庫檔案被 .gitignore 涵蓋時，乾跑報告 ignored（同一條接線的另一種答案）", async () => {
  const root = await makeRepo("cli-gitignore-db-ign-");
  try {
    writeFileSync(path.join(root, ".gitignore"), "*.db\n");
    assert.equal(await dryRunGitignoreStatus(root), "ignored");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
