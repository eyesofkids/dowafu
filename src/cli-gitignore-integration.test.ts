import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// plan_dispatch_v1.11.md §10：gitignore 檢查的基準必須與 outDir 的解析基準（cwd）一致，
// 不是 --repo-root。這個 bug 的本質是「cli.ts 的呼叫端傳錯基準」，不是 checkGitignore
// 這支函式自己的邏輯錯——給它任何一個明確的基準，它都正確算出那個基準下的三態。純粹
// 對 checkGitignore 做單元測試因此測不到這個 bug：真正要驗證的是 cli.ts 實際呼叫它時
// 傳的是哪個值。故用「真的把 cli.ts 跑起來」的整合測試，用 cwd ≠ --repo-root 的組合
// 重現 hub 驗收實測到的情境（cwd 側沒有 .gitignore，--repo-root 指向另一個已忽略
// tmp/ 的 repo），比對報表印出的是 ⚠（正確）還是 ℹ（v1.10 的 bug）。

const CLI_ENTRY = fileURLToPath(new URL("./cli.ts", import.meta.url));

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
}

function runCli(args: string[], cwd: string, extraEnv: Record<string, string>) {
  return spawnSync("npx", ["tsx", CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

test("gitignore 檢查：cwd ≠ --repo-root 時，報表依 cwd 的 .gitignore 判定（⚠），不是 --repo-root 的（v1.10 bug 是誤判為 ℹ）", () => {
  const cwdDir = mkdtempSync(path.join(os.tmpdir(), "dispatch-cli-gitignore-cwd-"));
  const repoRootDir = mkdtempSync(path.join(os.tmpdir(), "dispatch-cli-gitignore-repo-root-"));
  const emptyDispatchHome = mkdtempSync(path.join(os.tmpdir(), "dispatch-cli-gitignore-home-"));
  try {
    // cwd 側：git repo，沒有 .gitignore → tmp/ 不被忽略，正確答案是 not_ignored（⚠）。
    initGitRepo(cwdDir);

    // --repo-root 側：完全不相干的另一個 git repo，且有 .claude/agents/<agent>.md
    // （resolveSpokes 需要）；刻意設一份會忽略 tmp/ 的 .gitignore，代表「錯的參考系」——
    // 舊版 bug 會因為 outDir 不在這個 repo 的工作樹內而拿到 unknown（ℹ），不是套用它的規則。
    initGitRepo(repoRootDir);
    writeFileSync(path.join(repoRootDir, ".gitignore"), "tmp/\n");
    mkdirSync(path.join(repoRootDir, ".claude", "agents"), { recursive: true });
    writeFileSync(
      path.join(repoRootDir, ".claude", "agents", "hole-finder-cost.md"),
      "---\nmodel: opus\n---\n測試用 agent body",
    );

    const ticketDir = path.join(cwdDir, "ticket-gitignore-test");
    mkdirSync(ticketDir, { recursive: true });
    writeFileSync(
      path.join(ticketDir, "_dispatch.md"),
      [
        "<!-- format: v1 -->",
        "# dispatch ticket-gitignore-test",
        "",
        "| agent | provider | model | effort |",
        "| --- | --- | --- | --- |",
        "| hole-finder-cost | deepseek | deepseek-v4-flash | |",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(ticketDir, "_shared.md"),
      "# 前提（不受審）\n- 測試\n\n# 待審段落\n測試用文字。\n",
    );
    writeFileSync(path.join(ticketDir, "hole-finder-cost.md"), "# 具體問題\n1. 測試\n\n# 允許讀取\n");

    const result = runCli(
      ["ticket-gitignore-test", "--repo-root", repoRootDir, "--dry-run"],
      cwdDir,
      { DEEPSEEK_API_KEY: "fake-key-for-dry-run-only", DISPATCH_HOME: emptyDispatchHome },
    );

    assert.equal(result.status, 0, `dry-run 應成功結束，stderr：${result.stderr}`);
    // plan_i18n_impl_tickets T5：report.ts 起改吃 run-level lang（本測試未帶 --lang，
    // 落到內建預設 en，見 plan_i18n_v1.2.md §1.1），輸出因此是英文——這條斷言驗的是
    // 「依 cwd 判定、印出 ⚠ 而非 ℹ」這件事本身，語言不是重點，故不鎖死某一種語言的措辭。
    assert.match(result.stdout, /⚠.*(輸出目錄|Output directory).*(tmp\/spoke\/ticket-gitignore-test)/, `應印 ⚠ 警告，實際輸出：\n${result.stdout}`);
    assert.doesNotMatch(result.stdout, /ℹ.*(無法判定|Cannot determine)/, "不該退化成「無法判定」——cwd 側是真的可判定的 git repo");
  } finally {
    rmSync(cwdDir, { recursive: true, force: true });
    rmSync(repoRootDir, { recursive: true, force: true });
    rmSync(emptyDispatchHome, { recursive: true, force: true });
  }
});
