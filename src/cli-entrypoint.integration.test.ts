import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 熱修補（票 key-visibility 驗收）的守衛測試。
//
// 票 key-visibility 為了 B-0 的可測縫，把 main() 的呼叫包進了「這支檔案是不是被直接執行」
// 的判斷。原本用 `path.resolve` 比對 `process.argv[1]`，而 **resolve 不解析 symlink**——
// 經由 symlink 呼叫時它與 `import.meta.url`（Node 解析過的真實路徑）永遠不相等，
// **main() 不執行、CLI 什麼都不印、exit 仍是 0**。
//
// 為什麼 583 條測試抓不到：測試都 import 模組或走絕對真實路徑；daemon 的 runCliJob 與
// MCP stdio 也都用絕對真實路徑 spawn；這台機器的 pnpm shim 傳的是帶 `..` 的相對路徑，
// resolve 之後恰好相等。**唯一會踩到的是 `npm install -g`——而那正是 README 教的安裝方式**
// （npm 在 node_modules/.bin 建的是 symlink）。
//
// 所以這裡不 import 任何東西來測，只做一件事：**用 symlink 真的把 CLI 叫起來，看它有沒有
// 回話**。子行程走的是真實的入口判斷，不是被注入的替身。

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
const VERSION_PATTERN = /^\d+\.\d+\.\d+/;

function runCli(entry: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, ["--import", "tsx", entry, "--version"], {
    encoding: "utf8",
    // --version 在 CLI 最前面就短路，不碰 DB；仍然指到拋棄式目錄，確保任何路徑都不會
    // 意外落到使用者真正的 $DISPATCH_HOME。
    env: { ...process.env, DISPATCH_HOME: mkdtempSync(path.join(os.tmpdir(), "dowafu-entry-")) },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

test("CLI 經由 symlink 呼叫時仍然執行 main()，不是靜默 exit 0", { timeout: 60_000 }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dowafu-symlink-"));
  try {
    // 副檔名要保持 .ts，tsx 才會處理它；形態與 npm 在 node_modules/.bin 建的一致。
    const link = path.join(dir, "dowafu-link.ts");
    symlinkSync(cliPath, link);

    const viaSymlink = runCli(link);

    // 正面證據：真的印出版本號。**不要**斷言「stderr 不含某錯誤」——這批已經有過一條那樣
    // 的斷言，綠燈但不守任何東西（見 report_v0_5_0.md §五.2）。靜默失效的症狀正是
    // 「stdout 空、stderr 空、exit 0」，只有正面斷言分辨得出來。
    assert.match(
      viaSymlink.stdout.trim(),
      VERSION_PATTERN,
      `經由 symlink 呼叫時 CLI 沒有輸出版本號（靜默失效？）stdout=${JSON.stringify(viaSymlink.stdout)} stderr=${JSON.stringify(viaSymlink.stderr)} status=${viaSymlink.status}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI 走真實路徑呼叫仍然正常（對照組，確認守衛沒有被改壞成永遠執行）", { timeout: 60_000 }, () => {
  const direct = runCli(cliPath);
  assert.match(direct.stdout.trim(), VERSION_PATTERN, `直接路徑呼叫沒有輸出版本號 stderr=${JSON.stringify(direct.stderr)}`);
});
