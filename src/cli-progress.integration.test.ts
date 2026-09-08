// B（gaps #6）：進度落檔的**接線**測試，不是函式測試。
//
// progress.test.ts 測的是「給 recordRound 一輪，它會寫進去」，protocol.test.ts 測的是
// 「dispatch_status 會把 readProgress 的東西印出來」——**兩條都綠，也證明不了派工途中真的
// 有人在每一輪叫它**。`runner.ts` 的 `round` 事件本來就有一個消費者被拔掉過
// （RunLogWriter → run.jsonl，票 B 退場），這次要有東西守著它。
// 這是那個家族的第 12 次（v0_5_0/_archived/log.md §二）。
//
// ⚠️ 環境：交接文記著「這個環境的子行程連不到父行程開的 loopback server」。
// **2026-09-07 實測：那條限制比它寫的窄——不通的是「父行程開的」，兄弟行程之間可以。**
// 所以假 provider 必須用 spawn 起成另一個子行程，**不可以**在測試行程裡 createServer。
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { addSpoke, createTicket } from "./ticket-store.js";
import { setProviderKey } from "./provider-key.js";
import { mergeProviders, readProvidersFile, setModelEnabled } from "./providers-store.js";
import { readProgress } from "./progress.js";

const CLI_ENTRY = fileURLToPath(new URL("./cli.ts", import.meta.url));

// 假的 Responses API：一輪就給完整答案（沒有 tool call），所以 runner 跑完第一輪就收工。
// usage 給的是可辨識的數字——progress 那一列必須帶著它們，才證明資料是從真的 round 事件
// 來的，不是某個佔位符。
const FAKE_SERVER = `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const body = JSON.stringify({
  id: "resp_fake", object: "response", created_at: 0, model: "fake-model", status: "completed",
  output: [{ type: "message", id: "msg_fake", role: "assistant", status: "completed",
             content: [{ type: "output_text", text: "觀察：測試用回應。", annotations: [] }] }],
  usage: { input_tokens: 4242, output_tokens: 1717, total_tokens: 5959 },
});
const server = createServer((req, res) => {
  let received = "";
  req.on("data", (c) => { received += c; });
  req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(body); });
});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(process.argv[2], String(server.address().port));
});
`;

const PROVIDERS = (port: number) => ({
  formatVersion: 1,
  fake: {
    baseURL: `http://127.0.0.1:${port}/v1`,
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
});

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", CLI_ENTRY, ...args], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function startFakeProvider(root: string): Promise<{ port: number; stop: () => void }> {
  const scriptPath = path.join(root, "fake-provider.mjs");
  const portPath = path.join(root, "port.txt");
  writeFileSync(scriptPath, FAKE_SERVER);
  const child: ChildProcess = spawn(process.execPath, [scriptPath, portPath], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    if (existsSync(portPath)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!existsSync(portPath)) {
    child.kill();
    throw new Error("假 provider 沒有在 5 秒內啟動");
  }
  return { port: Number(readFileSync(portPath, "utf8")), stop: () => child.kill() };
}

test("CLI：派工途中每輪都把進度寫進 DB，不是只有跑完才有東西可查", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cli-progress-"));
  let provider: { port: number; stop: () => void } | null = null;
  try {
    provider = await startFakeProvider(root);
    mkdirSync(path.join(root, ".claude", "agents"), { recursive: true });
    writeFileSync(path.join(root, ".claude", "agents", "hole-finder-cost.md"), "測試用 agent 定義");
    const providersPath = path.join(root, "providers.json");
    writeFileSync(providersPath, JSON.stringify(PROVIDERS(provider.port)));

    const dbPath = path.join(root, "dowafu.db");
    const db = openDb(dbPath, "en");
    mergeProviders(db, await readProvidersFile(providersPath, "en"), false);
    setModelEnabled(db, "fake", "fake-model", true, "en");
    setProviderKey(db, "fake", "test-key-abc123xyz");
    createTicket(db, "sample", "# 待審段落\n內容\n", "zh");
    addSpoke(db, "sample", {
      agent: "hole-finder-cost",
      provider: "fake",
      model: "fake-model",
      body: "# 具體問題\n1. 問題\n\n# 允許讀取\n",
    }, "zh");
    db.close();

    const run = await runCli(
      ["sample", "--db", dbPath, "--repo-root", root, "--yes"],
      { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "en" },
    );

    const check = openDb(dbPath, "en");
    try {
      const progress = readProgress(check, "sample");
      assert.equal(progress.length, 1, `應有一支 spoke 的進度，實際 ${progress.length}；stderr：${run.stderr}`);
      assert.equal(progress[0].agent, "hole-finder-cost");
      assert.ok(progress[0].rounds >= 1, "至少要記到一輪");
      // 正面證據：token 數必須是假 server 回報的那組可辨識數字，不是佔位符或 0。
      assert.equal(progress[0].tokensIn, 4242);
      assert.equal(progress[0].tokensOut, 1717);
      assert.ok(progress[0].lastAt, "每一列都要有時間戳——「哪一輪慢」靠它");
    } finally {
      check.close();
    }
  } finally {
    provider?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
