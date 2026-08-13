import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// plan_i18n_impl_tickets T3〈T1 驗收帶出的兩條〉之 B：v1.3 §二之2 #5／#6 先前只測了
// 「帶壞 --lang 也照印 help、不中止」那一半（T1，cli-args.test.ts）。HELP_TEXT 在 T1 還是
// 單語，抽 key 之後才有另一半可測：help 本身印哪一種語言。這三條非跑真的行程不可——
// help 的語言由 cli.ts 的 main() 讀 process.env.DISPATCH_LANG 決定（resolveFallbackLang），
// 純函式層級的 parseArgs／resolveFallbackLang 單元測試（見 cli-args.test.ts）只能驗證
// 「這個函式對這個輸入回傳什麼」，驗不到「main() 真的把這個回傳值接去印 help」，用法同
// cli-gitignore-integration.test.ts。

const CLI_ENTRY = fileURLToPath(new URL("./cli.ts", import.meta.url));

function runCli(args: string[], extraEnv: Record<string, string | undefined>) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "dispatch-cli-help-lang-"));
  try {
    return spawnSync("npx", ["tsx", CLI_ENTRY, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...extraEnv },
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// 每個測試各自給一個空的 DISPATCH_HOME，避免真的讀到執行機器上 ~/.config/dowafu/.env
// 裡可能設定的 DISPATCH_LANG，干擾這裡刻意控制的 env 組合（同 cli-gitignore-integration
// 的作法）。

test("--help：DISPATCH_LANG=en 時印英文 help（env 有效時用 env）", () => {
  const emptyHome = mkdtempSync(path.join(os.tmpdir(), "dispatch-cli-help-lang-home-"));
  try {
    const result = runCli(["--help"], { DISPATCH_HOME: emptyHome, DISPATCH_LANG: "en" });
    assert.equal(result.status, 0, `--help 應以 exit 0 結束，stderr：${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
    assert.doesNotMatch(result.stdout, /用法：/);
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
  }
});

test("--help：DISPATCH_LANG 未設定／無效時印內建預設語言的 help，且不中止", () => {
  const emptyHome = mkdtempSync(path.join(os.tmpdir(), "dispatch-cli-help-lang-home-"));
  try {
    const unset = runCli(["--help"], { DISPATCH_HOME: emptyHome, DISPATCH_LANG: undefined });
    assert.equal(unset.status, 0, `DISPATCH_LANG 未設定時 --help 應以 exit 0 結束，stderr：${unset.stderr}`);
    assert.match(unset.stdout, /Usage:/);

    const invalid = runCli(["--help"], { DISPATCH_HOME: emptyHome, DISPATCH_LANG: "fr" });
    assert.equal(
      invalid.status,
      0,
      `DISPATCH_LANG 無效時 --help 仍應以 exit 0 結束（不驗語言），stderr：${invalid.stderr}`,
    );
    assert.match(invalid.stdout, /Usage:/);
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
  }
});

test("--help：--lang zh-tw 不影響 help 的語言（短路在旗標迴圈之前，仍照 DISPATCH_LANG 判定）", () => {
  const emptyHome = mkdtempSync(path.join(os.tmpdir(), "dispatch-cli-help-lang-home-"));
  try {
    const result = runCli(["--lang", "zh-tw", "--help"], { DISPATCH_HOME: emptyHome, DISPATCH_LANG: "en" });
    assert.equal(result.status, 0, `--help 應以 exit 0 結束，stderr：${result.stderr}`);
    // DISPATCH_LANG=en 有效，--lang zh-tw 若被誤用去決定 help 語言，這裡會印成中文——
    // 斷言英文，證明短路確實發生在旗標迴圈之前，--lang 對 help 完全無感。
    assert.match(result.stdout, /Usage:/);
    assert.doesNotMatch(result.stdout, /用法：/);
  } finally {
    rmSync(emptyHome, { recursive: true, force: true });
  }
});
