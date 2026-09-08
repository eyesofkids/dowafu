import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { submitJob } from "./job.js";
import { loadTicket } from "./ticket.js";
import {
  addAllow,
  addSpoke,
  createTicket,
  formatTicket,
  getTicketDoc,
  getTicketHardCapUsd,
  hasResults,
  importTicketDirectory,
} from "./ticket-store.js";
import { DispatchError } from "./types.js";

const SHARED = "# 前提（不受審）\n- none\n\n# 待審段落\nreview body\n";
const BODY = "# 具體問題\n1. 能否驗證？\n\n# 允許讀取\n- source.txt\n";
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

function withTempDb(run: (dbPath: string, root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), "ticket-store-"));
  return run(path.join(root, "dowafu.db"), root).finally(() => rmSync(root, { recursive: true, force: true }));
}

function addSampleSpoke(dbPath: string): ReturnType<typeof openDb> {
  const db = openDb(dbPath);
  db.prepare("INSERT INTO providers (name, base_url, api, store, tool_calling, reasoning, chars_per_token, pricing_source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("deepseek", "https://example.test", "responses", 0, 1, JSON.stringify({ style: "openai", allowed: ["low"], default: "low" }), 2, JSON.stringify({ asOf: "2026-09-02" }), "2026-09-02T00:00:00.000Z");
  db.prepare("INSERT INTO models (provider, model, input_per_m, cached_input_per_m, output_per_m, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("deepseek", "deepseek-v4-flash", 0.13, 0.07, 0.91, 1, "2026-09-02T00:00:00.000Z");
  createTicket(db, "sample", SHARED, "zh");
  addSpoke(db, "sample", { agent: "hole-finder-cost", provider: "deepseek", model: "deepseek-v4-flash", body: BODY }, "zh");
  return db;
}

test("ticket-store：createTicket 建立後不可重名，addSpoke 的同 agent 重複被拒絕", async () => {
  await withTempDb(async (dbPath) => {
    const db = addSampleSpoke(dbPath);
    assert.throws(() => createTicket(db, "sample", SHARED, "zh"), DispatchError);
    assert.throws(
      () => addSpoke(db, "sample", { agent: "hole-finder-cost", provider: "deepseek", model: "deepseek-v4-flash", body: BODY }, "zh"),
      DispatchError,
    );
  });
});

test("ticket-store：addAllow 快照內容，formatTicket 顯示單價、查證日、帶單位的估算，並按 provider chars_per_token 計算", async () => {
  await withTempDb(async (dbPath, root) => {
    writeFileSync(path.join(root, "source.txt"), "first snapshot");
    const db = addSampleSpoke(dbPath);
    await addAllow(db, "sample", "hole-finder-cost", "source.txt", root, "zh");
    writeFileSync(path.join(root, "source.txt"), "changed on disk");
    assert.equal(getTicketDoc(db, "sample", "zh").spokes[0].allow[0].content, "first snapshot");
    const shown = formatTicket(db, "sample", "en");
    assert.match(shown, /deepseek\/deepseek-v4-flash/);
    assert.match(shown, /source\.txt/);
    assert.match(shown, /est\. 7 tokens/);
    assert.match(shown, /input \$0\.13.*output \$0\.91.*cached input \$0\.07/);
    assert.match(shown, /priced as of 2026-09-02/);
  });
});

test("ticket-store：formatTicket 缺價目不印 $0，重跑只統計 completed，且 completed 為零時不印重跑行", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ticket-store-summary-"));
  try {
    const db = addSampleSpoke(path.join(root, "dowafu.db"));
    const fresh = formatTicket(db, "sample", "en");
    assert.equal(fresh.includes("Completed"), false);
    // 票 cost-cap §C-2：新工單（N=0）只印硬上限，「典型」整段不出現，不留任何代表 0 的佔位符。
    assert.match(fresh, /Hard cap \$[\d.]+ \(absolute upper bound, not a prediction\)/);
    assert.equal(fresh.includes("Typical"), false);
    db.prepare("INSERT INTO jobs (id, ticket, status, created_at, finished_at, cost_usd) VALUES (?, ?, ?, ?, ?, ?)")
      .run("completed-priced", "sample", "completed", "2026-09-02T00:00:00.000Z", "2026-09-02T01:00:00.000Z", 1.25);
    db.prepare("INSERT INTO jobs (id, ticket, status, created_at, finished_at, cost_usd) VALUES (?, ?, ?, ?, ?, ?)")
      .run("completed-unpriced", "sample", "completed", "2026-09-02T00:00:01.000Z", "2026-09-02T02:00:00.000Z", null);
    db.prepare("INSERT INTO jobs (id, ticket, status, created_at, finished_at, cost_usd) VALUES (?, ?, ?, ?, ?, ?)")
      .run("failed-costly", "sample", "failed", "2026-09-02T00:00:02.000Z", "2026-09-02T03:00:00.000Z", 99);
    const rerun = formatTicket(db, "sample", "en");
    assert.match(rerun, /Completed 2 times/);
    assert.match(rerun, /total \$1\.2500/);
    assert.match(rerun, /last 2026-09-02T02:00:00\.000Z/);
    assert.equal(rerun.includes("99.0000"), false);
    // 票 cost-cap §C：典型 = jobs.cost_usd 的 sum／count（沿用票 B 已撈的同一份資料，不另開一套）
    // = 1.25 / 2 = 0.625。
    assert.match(rerun, /Typical \$0\.6250 \(last 2 runs\) \/ hard cap \$[\d.]+ \(absolute upper bound, not a prediction\)/);

    db.prepare("UPDATE models SET input_per_m = NULL, cached_input_per_m = NULL, output_per_m = NULL WHERE provider = ? AND model = ?")
      .run("deepseek", "deepseek-v4-flash");
    const missing = formatTicket(db, "sample", "en");
    assert.match(missing, /No pricing data/);
    assert.equal(missing.includes("$0"), false);
    // 票 cost-cap §B-3 #1：缺價目資料時硬上限也不印 $0，明講「無價目資料」。
    assert.match(missing, /Hard cap: no pricing data/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 票 cost-cap §D／§B-3 #3：formatTicket 無法得知本次實際 CLI 引數（`ticket show`／`approve`／
// MCP dispatch_submit 皆非派工當下），用 DEFAULT_MAX_TOOL_CALLS 當假設輪數；傳入不同的
// maxToolCalls 時硬上限要跟著變（沒有寫死的中間值）。
test("ticket-store：formatTicket 的 maxToolCalls 參數改變時，硬上限跟著變", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ticket-store-hardcap-"));
  try {
    const db = addSampleSpoke(path.join(root, "dowafu.db"));
    const low = formatTicket(db, "sample", "en", 5);
    const high = formatTicket(db, "sample", "en", 40);
    const lowHardCap = Number(/Hard cap \$([\d.]+)/.exec(low)![1]);
    const highHardCap = Number(/Hard cap \$([\d.]+)/.exec(high)![1]);
    assert.ok(highHardCap > lowHardCap, `maxToolCalls 越大，硬上限應越大：low(5)=${lowHardCap}，high(40)=${highHardCap}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 工單 approve-tool §A-1 之二：formatTicket 與 MCP 的 dispatch_approve 必須共用同一份
// 硬上限算法（getTicketHardCapUsd），不得各算各的——否則「摘要上寫 $1.77、核准時卻說金額
// 不符」，使用者無從判斷誰對。
test("ticket-store：getTicketHardCapUsd 與 formatTicket 印出的硬上限一致，缺價目資料時回 null", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ticket-store-hardcap-fn-"));
  try {
    const db = addSampleSpoke(path.join(root, "dowafu.db"));
    const shown = formatTicket(db, "sample", "en");
    const expected = Number(/Hard cap \$([\d.]+)/.exec(shown)![1]);
    const actual = getTicketHardCapUsd(db, "sample", "en");
    assert.ok(actual !== null);
    assert.equal(actual!.toFixed(4), expected.toFixed(4));

    // maxToolCalls 參數同樣要對齊 formatTicket 的行為（同一顆常數、同一份公式）。
    const highShown = formatTicket(db, "sample", "en", 40);
    const highExpected = Number(/Hard cap \$([\d.]+)/.exec(highShown)![1]);
    assert.equal(getTicketHardCapUsd(db, "sample", "en", 40)!.toFixed(4), highExpected.toFixed(4));

    db.prepare("UPDATE models SET input_per_m = NULL, cached_input_per_m = NULL, output_per_m = NULL WHERE provider = ? AND model = ?")
      .run("deepseek", "deepseek-v4-flash");
    assert.equal(getTicketHardCapUsd(db, "sample", "en"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI approve：空 DB 的 seeded 接線、免參數、短 id 與歧義前綴均守住核准閘門", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cli-approve-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    const db = openDb(dbPath, "en");
    const doc = JSON.stringify({
      shared: "# Under review\ntext\n",
      spokes: [{ agent: "reviewer", provider: "deepseek", model: "deepseek-v4-flash", body: "# Questions\n1. Check\n", allow: [{ path: "source.txt", content: "abcdefgh" }] }],
    });
    for (const name of ["single", "many", "prefix", "ambiguous"]) {
      db.prepare("INSERT INTO tickets (name, doc, created_at) VALUES (?, ?, ?)").run(name, doc, "2026-09-02T00:00:00.000Z");
    }
    submitJob(db, "single", "11111111-0000-0000-0000-000000000001");
    db.close();
    const env = { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "en" };

    const emptyDbPath = path.join(root, "empty.db");
    openDb(emptyDbPath, "en").close();
    const none = await runCli(["approve", "--db", emptyDbPath], env);
    assert.equal(none.code, 0, `zero pending should be a human-readable success; stderr: ${none.stderr}`);
    assert.match(none.stdout, /There are no jobs awaiting approval/);

    const one = await runCli(["approve", "--db", dbPath], env);
    assert.equal(one.code, 0, `single pending approval should succeed; stderr: ${one.stderr}`);
    assert.match(one.stderr, /seeded from the bundled file/);
    assert.match(one.stdout, /Price per M tokens/);
    assert.match(one.stdout, /Approved job: 11111111-0000-0000-0000-000000000001/);

    const pending = openDb(dbPath, "en");
    submitJob(pending, "many", "22222222-0000-0000-0000-000000000002");
    submitJob(pending, "many", "33333333-0000-0000-0000-000000000003");
    pending.close();
    const many = await runCli(["approve", "--db", dbPath], env);
    assert.equal(many.code, 0, `multiple pending should only list candidates; stderr: ${many.stderr}`);
    assert.match(many.stdout, /2 pending approvals/);
    assert.match(many.stdout, /22222222.*many/);
    assert.match(many.stdout, /33333333.*many/);

    const afterMany = openDb(dbPath, "en");
    assert.equal((afterMany.prepare("SELECT status FROM jobs WHERE id = ?").get("22222222-0000-0000-0000-000000000002") as { status: string }).status, "pending_approval");
    submitJob(afterMany, "prefix", "abcdef12-0000-0000-0000-000000000004");
    submitJob(afterMany, "ambiguous", "deadbeef-0000-0000-0000-000000000005");
    submitJob(afterMany, "ambiguous", "deadbeef-0000-0000-0000-000000000006");
    afterMany.close();

    const short = await runCli(["approve", "abcdef12", "--db", dbPath], env);
    assert.equal(short.code, 0, `unique prefix should approve; stderr: ${short.stderr}`);
    assert.match(short.stdout, /Approved job: abcdef12-0000-0000-0000-000000000004/);
    const ambiguous = await runCli(["approve", "deadbeef", "--db", dbPath], env);
    assert.equal(ambiguous.code, 0, `ambiguous prefix should list candidates only; stderr: ${ambiguous.stderr}`);
    assert.match(ambiguous.stdout, /matches 2 jobs/);
    // 熱修補（票 B 驗收）：訊息叫人「給長一點的 id」，所以列出來的候選必須**真的分得出來**。
    // 原本一律截到 8 碼，而歧義前綴的每一筆前 8 碼必然相同——照著那份清單做不到任何事。
    // 這兩個 id 只差最後一個字元，故必須印到足以區分為止。
    assert.match(ambiguous.stdout, /deadbeef-0000-0000-0000-000000000005/);
    assert.match(ambiguous.stdout, /deadbeef-0000-0000-0000-000000000006/);
    const final = openDb(dbPath, "en");
    assert.equal((final.prepare("SELECT status FROM jobs WHERE id = ?").get("deadbeef-0000-0000-0000-000000000005") as { status: string }).status, "pending_approval");
    assert.equal((final.prepare("SELECT status FROM jobs WHERE id = ?").get("deadbeef-0000-0000-0000-000000000006") as { status: string }).status, "pending_approval");
    final.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI approve：完整摘要必須在 approveJob 改變狀態之前印出", () => {
  const source = readFileSync(CLI_ENTRY, "utf8");
  const summaryAt = source.indexOf("console.log(ticketSummary);");
  const approveAt = source.indexOf("const job = approveJob(db, before.id);");
  assert.notEqual(summaryAt, -1);
  assert.notEqual(approveAt, -1);
  assert.ok(summaryAt < approveAt);
});

test("ticket-store：importTicketDirectory 的 DB 工單與磁碟解析等價，hasResults 分辨真假", async () => {
  await withTempDb(async (dbPath, root) => {
    writeFileSync(path.join(root, "source.txt"), "source snapshot");
    const ticketDir = path.join(root, "legacy-ticket");
    mkdirSync(ticketDir);
    writeFileSync(
      path.join(ticketDir, "_dispatch.md"),
      "<!-- format: v1 -->\n| agent | provider | model | effort |\n| --- | --- | --- | --- |\n| hole-finder-cost | deepseek | deepseek-v4-flash | |\n",
    );
    writeFileSync(path.join(ticketDir, "_shared.md"), SHARED);
    writeFileSync(path.join(ticketDir, "hole-finder-cost.md"), BODY);

    const db = openDb(dbPath);
    db.prepare("INSERT INTO providers (name, base_url, api, store, tool_calling, reasoning, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("deepseek", "https://example.test", "responses", 0, 1, JSON.stringify({ style: "openai", allowed: ["low"], default: "low" }), "2026-09-02T00:00:00.000Z");
    db.prepare("INSERT INTO models (provider, model, enabled, updated_at) VALUES (?, ?, ?, ?)")
      .run("deepseek", "deepseek-v4-flash", 1, "2026-09-02T00:00:00.000Z");
    await importTicketDirectory(db, ticketDir, "imported", root, "zh");
    const fromDb = await loadTicket(db, "imported", "zh");
    const fromDir = await loadTicket(ticketDir, "zh");
    assert.deepEqual(fromDb.rows, fromDir.rows);
    assert.deepEqual(fromDb.shared, fromDir.shared);
    assert.deepEqual([...fromDb.perAgent], [...fromDir.perAgent]);
    assert.equal(hasResults(db, "imported"), false);
    db.prepare("INSERT INTO results (job_id, agent) VALUES (?, ?)").run("imported", "hole-finder-cost");
    assert.equal(hasResults(db, "imported"), true);
  });
});
