// 熱修補（票 A 驗收缺口二）：播種的**接線**測試。
//
// providers-store.test.ts 測的是「呼叫 seedIfEmpty 會播種」。那證明不了
// 「CLI 真的在開 DB 的時候叫了它」——而缺口一就是被同一個形態咬到的：
// 函式對不代表有人在對的時機叫它。
//
// 本測試走真的 CLI 子行程，重現驗收時撞到的那條路：全新的 DISPATCH_HOME、
// 全新的 DB，直接建工單並加一個「預設該開」的 spoke。修補前這裡會失敗，
// 訊息還是誤導性的「白名單為空（allowed: ）」。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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

test("CLI：全新安裝直接建得起工單——空表在開 DB 時就播種了出貨檔", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "cli-providers-seed-"));
  try {
    const shared = path.join(root, "shared.md");
    const body = path.join(root, "body.md");
    writeFileSync(shared, "# 待審段落\n內容\n");
    writeFileSync(body, "# 具體問題\n1. 問題\n\n# 允許讀取\n");
    const dbPath = path.join(root, "dowafu.db");
    const env = { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "en" };

    const created = await runCli(["ticket", "create", "sample", shared, "--db", dbPath], env);
    assert.equal(created.code, 0, `建工單應成功；stderr：${created.stderr}`);
    // 播種不得靜默——通知必須出現，而且必須在 stderr（stdout 要留給 --json／JSON-RPC）。
    assert.match(created.stderr, /seeded from the bundled file/, `應印出播種通知，實際 stderr：${created.stderr}`);

    // 預設該開的型號，在全新安裝上就要能用。
    const added = await runCli(
      ["ticket", "add-spoke", "sample", "hole-finder-cost", "deepseek", "deepseek-v4-flash", body, "--db", dbPath],
      env,
    );
    assert.equal(added.code, 0, `加 spoke 應成功；stderr：${added.stderr}`);

    // 預設關閉的型號在同一個全新安裝上必須被擋，且錯誤要是「已停用」而非「不在白名單」。
    const blocked = await runCli(
      ["ticket", "add-spoke", "sample", "reviewer-2", "anthropic", "claude-opus-5", body, "--db", dbPath],
      env,
    );
    assert.notEqual(blocked.code, 0, "預設關閉的型號不該加得進去");
    assert.match(blocked.stderr, /disabled/i, `應是停用訊息，實際：${blocked.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
