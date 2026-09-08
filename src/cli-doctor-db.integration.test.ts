// A（gaps #1）：`--doctor --db <路徑>` 的**接線**測試，不是函式測試。
//
// 修這個缺陷之前，doctor 分支寫死 `openDbSeeded(undefined, …)` 與
// `daemonStatePath(defaultDbPath())`——`--db` 在旗標迴圈裡有解析、卻在 `{ mode: "doctor" }`
// 那個回傳裡被丟掉。症狀是**診斷工具對著另一個資料庫回答你**：「我明明用 --db 設了 key，
// 它卻說沒有」，而那個回答本身是「對的」，只是回答的是別的檔。
//
// doctor.test.ts 測的是「給 buildDoctorReport 一條路徑，它會印出來」，cli-args.test.ts
// 測的是「parseArgs 會把 dbPath 帶回來」——**兩條都綠，也證明不了 cli.ts 真的把它接起來**。
// 這是那個家族的第 11 次（v0_5_0/_archived/log.md §二），所以走真的 CLI 子行程。
//
// **兩種情形必須給出不同的答案**：帶 --db 印指定的檔、不帶印預設的檔。只斷言「有印出某條
// 路徑」的話，一個永遠印 defaultDbPath() 的假實作也會過。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { daemonStatePath, writeHeartbeat } from "./liveness.js";

const CLI_ENTRY = fileURLToPath(new URL("./cli.ts", import.meta.url));

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", CLI_ENTRY, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", () => {});
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout }));
  });
}

test("CLI doctor：--db 決定報表講的是哪一個資料庫，且那個檔真的會被建出來", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cli-doctor-db-"));
  try {
    const home = path.join(root, "home");
    const other = path.join(root, "elsewhere", "other.db");
    const env = { ...process.env, DISPATCH_HOME: home, DOWAFU_DB: undefined } as NodeJS.ProcessEnv;
    delete env.DOWAFU_DB;

    const withFlag = await runCli(["--doctor", "--db", other], env);
    assert.equal(withFlag.code, 0);
    assert.match(withFlag.stdout, new RegExp(`Database\\s+${other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    // 指定的檔要真的被開起來（openDbSeeded 會建檔並播種），不是只有字串被印出來。
    assert.ok(existsSync(other), `--db 指定的檔沒有被建出來：${other}`);

    const withoutFlag = await runCli(["--doctor"], env);
    assert.equal(withoutFlag.code, 0);
    const defaultDb = path.join(home, "dowafu.db");
    assert.match(withoutFlag.stdout, new RegExp(`Database\\s+${defaultDb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    // 兩種情形給的是不同答案——這才排除得掉「永遠印預設路徑」的假實作。
    assert.notEqual(other, defaultDb);
    assert.doesNotMatch(withoutFlag.stdout, /elsewhere/);

    // daemon 那一行也必須跟著 --db 走。它先前是獨立的一句 daemonStatePath(defaultDbPath())
    // ——與同一份報表其餘各行取自不同資料庫，正是「同一行呼叫裡一活一死」那個形態。
    // 對 other.db 寫一份心跳，只有指到它時才該回報「執行中」。
    writeHeartbeat(daemonStatePath(other));
    const daemonWithFlag = await runCli(["--doctor", "--db", other], env);
    assert.match(daemonWithFlag.stdout, /Daemon\s+running/);
    const daemonWithoutFlag = await runCli(["--doctor"], env);
    assert.match(daemonWithoutFlag.stdout, /Daemon\s+not running/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
