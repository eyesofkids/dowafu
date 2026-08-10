import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { checkGitignore } from "./gitignore-check.js";

// plan_dispatch_v1.10.md §10／§20：gitignore 三態，不得合併——「未忽略」需要處理，
// 「無法判定」不是。用真實 git repo（temp dir）驅動，不 mock child_process：git 的行為
// 本身就是驗證對象，mock 掉等於沒測到。

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

test("checkGitignore：路徑被 .gitignore 涵蓋 → ignored", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "gitignore-check-"));
  try {
    initGitRepo(repo);
    writeFileSync(path.join(repo, ".gitignore"), "tmp/\n");
    const outDir = path.join(repo, "tmp", "spoke", "ticket-1");
    mkdirSync(outDir, { recursive: true });
    assert.equal(checkGitignore(outDir, repo), "ignored");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("checkGitignore：路徑未被任何規則涵蓋 → not_ignored", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "gitignore-check-"));
  try {
    initGitRepo(repo);
    writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n"); // 不涵蓋 tmp/
    const outDir = path.join(repo, "tmp", "spoke", "ticket-1");
    mkdirSync(outDir, { recursive: true });
    assert.equal(checkGitignore(outDir, repo), "not_ignored");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("checkGitignore：目標目錄根本不是 git repo → unknown（不得誤判為 not_ignored）", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gitignore-check-nonrepo-"));
  try {
    const outDir = path.join(dir, "tmp", "spoke", "ticket-1");
    mkdirSync(outDir, { recursive: true });
    assert.equal(checkGitignore(outDir, dir), "unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkGitignore：沒有 .gitignore 檔案的 git repo → not_ignored（不是 unknown）", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "gitignore-check-norules-"));
  try {
    initGitRepo(repo);
    const outDir = path.join(repo, "tmp", "spoke", "ticket-1");
    mkdirSync(outDir, { recursive: true });
    assert.equal(checkGitignore(outDir, repo), "not_ignored");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// plan_dispatch_v1.11.md §10：outDir 相對 cwd 解析（v1.11 §24.5），故判定基準也必須是
// cwd，不是 --repo-root。用兩個「互不相關」的 git repo 模擬 cwd ≠ repoRoot：outDir 實際
// 落在 A（沒有 .gitignore，tmp/ 不被忽略），B 是完全不相干的另一個 repo（刻意設一份會
// 忽略 tmp/ 的 .gitignore，代表「錯的參考系」——舊版實作用 `-C repoRoot` 時，若呼叫端把
// repoRoot 當基準傳進來，得到的就是 B）。
//
// 這支測試證明兩件事：(1) 傳對基準（A）會得到正確答案；(2) 傳錯基準（B，模擬舊版
// `-C repoRoot` 的呼叫模式）會得到「unknown」而非「悄悄answer 對」——即函式的結果真的
// 跟著傳入的基準走，不是內部寫死或退回 process.cwd()。只測「基準剛好等於 outDir 所在
// 位置」的單一案例，改前改後都會綠，等於沒測到 hub 驗收實際踩到的那個 bug。
test("checkGitignore：結果隨傳入的基準而定——傳對（outDir 實際所在）與傳錯（不相干的另一個 repo）結果不同", () => {
  const correctBasis = mkdtempSync(path.join(os.tmpdir(), "gitignore-check-correct-basis-"));
  const wrongBasis = mkdtempSync(path.join(os.tmpdir(), "gitignore-check-wrong-basis-"));
  try {
    initGitRepo(correctBasis); // 沒有 .gitignore，tmp/ 不被忽略
    initGitRepo(wrongBasis);
    writeFileSync(path.join(wrongBasis, ".gitignore"), "tmp/\n"); // 錯的參考系：會忽略 tmp/
    const outDir = path.join(correctBasis, "tmp", "spoke", "ticket-1");
    mkdirSync(outDir, { recursive: true });

    // 傳對基準：依 correctBasis 自己的規則（沒有 .gitignore）→ not_ignored。
    assert.equal(checkGitignore(outDir, correctBasis), "not_ignored");
    // 傳錯基準（模擬舊版 -C repoRoot 誤用）：outDir 不在 wrongBasis 的工作樹內，
    // git 對外部路徑回 fatal（exit 128）→ unknown，不是悄悄套用 wrongBasis 的規則。
    assert.equal(checkGitignore(outDir, wrongBasis), "unknown");
  } finally {
    rmSync(correctBasis, { recursive: true, force: true });
    rmSync(wrongBasis, { recursive: true, force: true });
  }
});
