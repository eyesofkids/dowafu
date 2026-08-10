import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDispatchHome, loadDispatchEnv } from "./dispatch-home.js";

// plan_dispatch_v1.10.md §24.4／§20：DISPATCH_HOME 三種情境的解析，以及 cwd 的 `.env`
// 明文禁令——「沒有測試就沒有任何東西阻止日後有人把 import "dotenv/config" 加回來」。

test("resolveDispatchHome：明設 DISPATCH_HOME 時直接採用，優先於 XDG_CONFIG_HOME", () => {
  const home = resolveDispatchHome({ DISPATCH_HOME: "/explicit/dispatch", XDG_CONFIG_HOME: "/xdg" });
  assert.equal(home, "/explicit/dispatch");
});

test("resolveDispatchHome：未設 DISPATCH_HOME 時採 $XDG_CONFIG_HOME/dispatch", () => {
  const home = resolveDispatchHome({ XDG_CONFIG_HOME: "/xdg-config" });
  assert.equal(home, path.join("/xdg-config", "dispatch"));
});

test("resolveDispatchHome：兩者皆未設時採 ~/.config/dispatch", () => {
  const home = resolveDispatchHome({}, () => "/home/testuser");
  assert.equal(home, path.join("/home/testuser", ".config", "dispatch"));
});

test("loadDispatchEnv：DISPATCH_HOME 下的 .env 會被讀取（正向對照組）", () => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "dispatch-home-"));
  writeFileSync(path.join(tmpHome, ".env"), "DISPATCH_HOME_TEST_VAR=from-dispatch-home\n");
  try {
    delete process.env.DISPATCH_HOME_TEST_VAR;
    loadDispatchEnv(tmpHome);
    assert.equal(process.env.DISPATCH_HOME_TEST_VAR, "from-dispatch-home");
  } finally {
    delete process.env.DISPATCH_HOME_TEST_VAR;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("loadDispatchEnv：不讀 cwd 的 .env——明文禁令（§24.4），即使 cwd 下真的有 .env 也不受影響", () => {
  const tmpCwd = mkdtempSync(path.join(os.tmpdir(), "dispatch-cwd-"));
  writeFileSync(path.join(tmpCwd, ".env"), "LEAKED_FROM_CWD=oops\n");
  const originalCwd = process.cwd();
  process.chdir(tmpCwd);
  try {
    delete process.env.LEAKED_FROM_CWD;
    // DISPATCH_HOME 指向一個不存在 .env 的目錄——若函式內部有任何路徑退回 dotenv 預設
    // （即讀 cwd 的 .env），這裡就會讀到 LEAKED_FROM_CWD。
    const emptyDispatchHome = mkdtempSync(path.join(os.tmpdir(), "dispatch-empty-home-"));
    loadDispatchEnv(emptyDispatchHome);
    assert.equal(process.env.LEAKED_FROM_CWD, undefined, "cwd 的 .env 不得被讀取");
    rmSync(emptyDispatchHome, { recursive: true, force: true });
  } finally {
    process.chdir(originalCwd);
    delete process.env.LEAKED_FROM_CWD;
    rmSync(tmpCwd, { recursive: true, force: true });
  }
});

test("loadDispatchEnv：ambient process.env 優先於 DISPATCH_HOME 的 .env（dotenv 預設不覆寫既有變數）", () => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "dispatch-home-ambient-"));
  writeFileSync(path.join(tmpHome, ".env"), "AMBIENT_PRIORITY_TEST=from-file\n");
  try {
    process.env.AMBIENT_PRIORITY_TEST = "from-ambient";
    loadDispatchEnv(tmpHome);
    assert.equal(process.env.AMBIENT_PRIORITY_TEST, "from-ambient");
  } finally {
    delete process.env.AMBIENT_PRIORITY_TEST;
    rmSync(tmpHome, { recursive: true, force: true });
  }
});
