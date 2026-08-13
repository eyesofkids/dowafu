import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { allowlistRejectMessage, buildAllowSet, checkAllowlist } from "./whitelist.js";

let tmpRoot: string;
let repoRoot: string;

before(async () => {
  // macOS：os.tmpdir() 常經 /var -> /private/var 符號連結，realpath 後路徑會變；
  // 一律先 realpath 過，避免測試期望值與 checkAllowlist 內部的 realpath 結果對不上。
  tmpRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "dispatch-whitelist-test-")));
  repoRoot = path.join(tmpRoot, "repo");
  await mkdir(path.join(repoRoot, "_docs"), { recursive: true });
  await writeFile(path.join(repoRoot, "_shared.md"), "shared");
  await writeFile(path.join(repoRoot, "allowed.txt"), "allowed");
  await writeFile(path.join(repoRoot, "not-allowed.txt"), "not allowed but exists in repo");
  await writeFile(path.join(repoRoot, "_docs", "secret.md"), "secret");
  await writeFile(path.join(tmpRoot, "outside.txt"), "outside the repo root");
});

after(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

test("允許清單內的路徑通過，回傳 realpath", () => {
  const allowSet = buildAllowSet([
    path.join(repoRoot, "_shared.md"),
    path.join(repoRoot, "allowed.txt"),
  ]);
  const result = checkAllowlist(allowSet, "allowed.txt", repoRoot);
  assert.equal(result.allowed, true);
  if (result.allowed) {
    assert.equal(result.realPath, path.join(repoRoot, "allowed.txt"));
  }
});

test("存在於 repo 內但不在允許清單 → not_in_allowlist（同目錄下其他檔案不得誤放行）", () => {
  const allowSet = buildAllowSet([path.join(repoRoot, "allowed.txt")]);
  const result = checkAllowlist(allowSet, "not-allowed.txt", repoRoot);
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.equal(result.reason, "not_in_allowlist");
});

test("_docs/ 底下即使誤放進允許清單，實際請求仍應被精確比對擋下（清單外路徑一律拒絕）", () => {
  const allowSet = buildAllowSet([path.join(repoRoot, "allowed.txt")]);
  const result = checkAllowlist(allowSet, "_docs/secret.md", repoRoot);
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.equal(result.reason, "not_in_allowlist");
});

test("不存在的路徑 → not_found，不區分於使用者可見訊息但內部分類保留", () => {
  const allowSet = buildAllowSet([path.join(repoRoot, "allowed.txt")]);
  const result = checkAllowlist(allowSet, "does-not-exist.txt", repoRoot);
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.equal(result.reason, "not_found");
});

test("repo 外的路徑 → outside_repo", () => {
  const allowSet = buildAllowSet([path.join(repoRoot, "allowed.txt")]);
  const result = checkAllowlist(allowSet, "../outside.txt", repoRoot);
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.equal(result.reason, "outside_repo");
});

test("前綴比對會誤放行，精確集合比對不會：allowed.txt 不應放行 allowed.txt.bak", async () => {
  await writeFile(path.join(repoRoot, "allowed.txt.bak"), "decoy");
  const allowSet = buildAllowSet([path.join(repoRoot, "allowed.txt")]);
  const result = checkAllowlist(allowSet, "allowed.txt.bak", repoRoot);
  assert.equal(result.allowed, false);
});

// i18n_classification_t2.md §三之2：這則訊息經 executeToolCall 送回 spoke 的對話（C 類，
// 消費者是 spoke），由 spoke.lang 直接選用，不進 messages.ts——這裡直接鎖住兩種語言的
// 字面量，避免中英任一版被順手改動。
test("allowlistRejectMessage：依 lang 回傳中英兩種固定文字", () => {
  assert.equal(allowlistRejectMessage("zh"), "不存在或不在允許範圍");
  assert.equal(allowlistRejectMessage("en"), "Not found or outside the allowed list");
});
