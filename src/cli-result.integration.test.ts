// `dowafu result` 的**接線**測試。output.test.ts 測的是 readResults 這支函式查得對，
// 那證明不了 CLI 真的有這個子指令、也真的把查到的東西印出來。
//
// 這個指令存在的理由本身就是一個接線缺口：D1 把產物搬進 DB 之後，**只有 MCP 的
// dispatch_result 讀得回來**，走 CLI 直接派工的人沒有對應指令。實測中的 Claude Code
// 因此自己去開 sqlite3（v0_5_0/_archived/log.md §八），當時被記成「client 又 shell out 了」的行為觀察。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { createTicket } from "./ticket-store.js";
import { m } from "./messages.js";

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

function withRoot(run: (root: string, dbPath: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "cli-result-"));
  const dbPath = path.join(root, "dowafu.db");
  return run(root, dbPath).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("CLI：dowafu result 印出該次派工的每一支 spoke 與稽核表", async () => {
  await withRoot(async (root, dbPath) => {
    const db = openDb(dbPath, "en");
    const insert = db.prepare(
      "INSERT INTO results (job_id, agent, output, request, response, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL)",
    );
    insert.run("auth-review", "hole-finder", "SPOKE-OUTPUT-MARKER 找到三個洞");
    insert.run("auth-review", "__summary__", "AUDIT-TABLE-MARKER 稽核表");
    db.close();

    const run = await runCli(["result", "auth-review", "--db", dbPath], { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "en" });
    assert.equal(run.code, 0, `應成功，實際 ${run.code}；stderr：${run.stderr}`);
    assert.match(run.stdout, /SPOKE-OUTPUT-MARKER/, "spoke 原文要印出來");
    assert.match(run.stdout, /AUDIT-TABLE-MARKER/, "稽核表要印出來");
  });
});

test("CLI：dowafu result 查無結果時講人話並以 exit 2 中止", async () => {
  await withRoot(async (root, dbPath) => {
    openDb(dbPath, "en").close();
    const run = await runCli(["result", "never-ran", "--db", dbPath], { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "en" });
    assert.equal(run.code, 2, `應以 exit 2 中止，實際 ${run.code}`);
    assert.ok(run.stderr.includes(m("en", "resultNotFound", "never-ran")), `實際 stderr：${run.stderr}`);
  });
});

test("CLI：dowafu result 接受完整 job id、ticket-id 與唯一短 id，且精確識別優先於短 id", async () => {
  await withRoot(async (root, dbPath) => {
    const db = openDb(dbPath, "en");
    createTicket(db, "shared-prefix", "# Under review\ntext\n", "en");
    createTicket(db, "ticket-only", "# Under review\ntext\n", "en");
    db.prepare("INSERT INTO jobs (id, ticket, status, created_at, finished_at) VALUES (?, ?, 'completed', ?, ?)")
      .run("shared-prefix-job-full", "ticket-only", "2026-09-09T00:00:00.000Z", "2026-09-09T00:01:00.000Z");
    db.prepare("INSERT INTO jobs (id, ticket, status, created_at, finished_at) VALUES (?, ?, 'completed', ?, ?)")
      .run("b9b94d13-full-id", "shared-prefix", "2026-09-09T00:00:00.000Z", "2026-09-09T00:02:00.000Z");
    const insert = db.prepare(
      "INSERT INTO results (job_id, agent, output, request, response, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL)",
    );
    insert.run("shared-prefix-job-full", "reviewer", "FULL-ID-MARKER");
    insert.run("b9b94d13-full-id", "reviewer", "SHORT-ID-MARKER");
    db.close();

    const env = { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "en" };
    const full = await runCli(["result", "shared-prefix-job-full", "--db", dbPath], env);
    const ticket = await runCli(["result", "shared-prefix", "--db", dbPath], env);
    const short = await runCli(["result", "b9b94d13", "--db", dbPath], env);
    assert.equal(full.code, 0, full.stderr);
    assert.match(full.stdout, /FULL-ID-MARKER/);
    assert.equal(ticket.code, 0, ticket.stderr);
    assert.match(ticket.stdout, /SHORT-ID-MARKER/, "精確 ticket-id 必須走該 ticket 的最近結果，不能當成 job 前綴");
    assert.equal(short.code, 0, short.stderr);
    assert.match(short.stdout, /SHORT-ID-MARKER/);
  });
});

test("CLI：dowafu result 的撞名短 id 不猜，列出可區分候選且中英不同", async () => {
  await withRoot(async (root, dbPath) => {
    const db = openDb(dbPath, "en");
    for (const [id, ticket] of [["collision-111-full", "one"], ["collision-222-full", "two"]]) {
      createTicket(db, ticket, "# Under review\ntext\n", "en");
      db.prepare("INSERT INTO jobs (id, ticket, status, created_at) VALUES (?, ?, 'approved', ?)").run(id, ticket, "2026-09-09T00:00:00.000Z");
    }
    db.close();

    const en = await runCli(["result", "collision-", "--db", dbPath], { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "en" });
    const zh = await runCli(["result", "collision-", "--db", dbPath], { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "zh-tw" });
    assert.equal(en.code, 0, en.stderr);
    assert.equal(zh.code, 0, zh.stderr);
    assert.match(en.stdout, /collision-1\s/);
    assert.match(en.stdout, /collision-2\s/);
    assert.match(zh.stdout, /collision-1\s/);
    assert.match(zh.stdout, /collision-2\s/);
    assert.notEqual(en.stdout, zh.stdout, "短 id 的新訊息不得固定回英文");
  });
});

// 驗收熱修補（票 status-stdin）：失敗 spoke 的字樣先前固定英文——`readResults` 新增的
// `lang` 參數有預設值 `"en"`，而這個子指令沒傳。中文模式下會在一片中文裡印出一段英文，
// 違反「對使用者的字串一律走 messages.ts 中英兩套」那條紀律。
//
// **兩種語言必須給出不同的答案**：只斷言「有印出失敗字樣」的話，一個固定回英文的實作
// 也會過——那正是修補前的狀態。
test("CLI：dowafu result 的失敗字樣跟著 --lang 走，不是固定英文", async () => {
  await withRoot(async (root, dbPath) => {
    const db = openDb(dbPath, "en");
    const insert = db.prepare(
      "INSERT INTO results (job_id, agent, output, request, response, tokens_in, tokens_out, cost_usd) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL)",
    );
    // output 為 NULL 是既有的失敗訊號（persistSpokeResultDb 只有 status === "failed" 才寫 NULL）。
    insert.run("lang-check", "reviewer-dead", null);
    db.close();

    const zh = await runCli(["result", "lang-check", "--db", dbPath], { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "zh-tw" });
    const en = await runCli(["result", "lang-check", "--db", dbPath], { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "en" });

    assert.ok(zh.stdout.includes(m("zh", "noFullReportAvailable", "failed")), `中文模式應印中文失敗字樣；實際：${zh.stdout}`);
    assert.ok(en.stdout.includes(m("en", "noFullReportAvailable", "failed")), `英文模式應印英文失敗字樣；實際：${en.stdout}`);
    assert.notEqual(m("zh", "noFullReportAvailable", "failed"), m("en", "noFullReportAvailable", "failed"));
  });
});
