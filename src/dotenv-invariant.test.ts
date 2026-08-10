import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanDotenvInvariant, ALLOWED_BARE_DOTENV_IMPORT_FILE } from "./dotenv-invariant.js";

// plan_dispatch_v1.11.md §20：這支測試守的是「不得做 X」的規格本身，不是某個函式的行為。
// 判準：想像 `import "dotenv/config"` 被寫回任一檔案，這支測試必須失敗——它確實會，因為
// 它逐行掃描原始碼原文，不透過任何一支入口間接觸發（不像 dispatch-home.test.ts 那樣
// 只驗證 loadDispatchEnv 的行為，沒人 import cli.ts 就測不到 cli.ts 頂部加回的 import）。
//
// repoRoot 用 process.cwd()：`pnpm test` 固定從 repo 根目錄執行（package.json 的
// test script），故此假設在測試執行環境下成立；掃描的是「這個 repo 現在的原始碼」，
// 不是建構出來的 fixture，這正是本測試要驗證的對象。

const REPO_ROOT = process.cwd();

test("dotenv 不變式：整個 repo（src/、scripts/）不得出現 dotenv/config import，唯一允許 import dotenv 本身的檔案是 dispatch-home.ts", () => {
  const violations = scanDotenvInvariant(REPO_ROOT);
  assert.deepEqual(
    violations,
    [],
    `發現違反 §24.4 禁令的 import：\n${violations.map((v) => `  ${v.file}:${v.line} [${v.kind}] ${v.text}`).join("\n")}`,
  );
});

test("ALLOWED_BARE_DOTENV_IMPORT_FILE 常數指向 dispatch-home.ts（例外名單不是空字串或打錯路徑）", () => {
  assert.equal(ALLOWED_BARE_DOTENV_IMPORT_FILE, path.join("src", "dispatch-home.ts"));
});

// hub 驗收（2026-08-06）：上一則測試只對「這個 repo現在」的原始碼斷言 []——若
// scanDotenvInvariant 未來被改壞（目錄清單打錯、regex 改壞、listTsFiles 回空），一樣會
// 回 []，測試照樣綠，禁令再次無人看守。這裡改用 fixture 目錄，直接驗證掃描器本身：
// 對已知含違規的原始碼，它是否真的抓得到，且不誤判允許例外的檔案與純註解。
test("scanDotenvInvariant：對 fixture 目錄能正確抓到兩種違規、不誤判允許例外檔與純註解——證明掃描器本身，不只是「這個 repo 目前乾淨」", () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "dotenv-scan-fixture-"));
  try {
    mkdirSync(path.join(fixtureRoot, "src"), { recursive: true });
    writeFileSync(path.join(fixtureRoot, "src", "bad-config-import.ts"), 'import "dotenv/config";\n');
    writeFileSync(path.join(fixtureRoot, "src", "bad-bare-import.ts"), 'import dotenv from "dotenv";\n');
    // 允許例外：路徑與 ALLOWED_BARE_DOTENV_IMPORT_FILE 一致，同樣的寫法不該被判違規。
    writeFileSync(path.join(fixtureRoot, "src", "dispatch-home.ts"), 'import dotenv from "dotenv";\n');
    // 純註解提到這兩個字串，不是真正的 import——不該被判違規。
    writeFileSync(
      path.join(fixtureRoot, "src", "clean.ts"),
      '// 這裡只是說明，不是真的 import "dotenv/config" 或 import dotenv from "dotenv"\nexport const x = 1;\n',
    );

    const violations = scanDotenvInvariant(fixtureRoot);

    assert.equal(violations.length, 2, `預期剛好 2 筆違規，實際：${JSON.stringify(violations)}`);
    assert.ok(
      violations.some(
        (v) => v.file === path.join("src", "bad-config-import.ts") && v.kind === "dotenv/config" && v.line === 1,
      ),
      "應抓到 bad-config-import.ts 的 dotenv/config 違規",
    );
    assert.ok(
      violations.some(
        (v) =>
          v.file === path.join("src", "bad-bare-import.ts") &&
          v.kind === "bare-dotenv-outside-allowed-file" &&
          v.line === 1,
      ),
      "應抓到 bad-bare-import.ts 的 bare-dotenv 違規",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
