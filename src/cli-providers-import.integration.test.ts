import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDb } from "./db.js";
import { bundledProvidersPath } from "./pkg-info.js";
import { listModels, mergeProviders, readProvidersFile } from "./providers-store.js";

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", path.join(process.cwd(), "src", "cli.ts"), ...args], { encoding: "utf8", env });
  return { status: result.status, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

test("CLI：providers import --bundled 以明確 bundled 語意合流並印出實際路徑", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-providers-bundled-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    const db = openDb(dbPath, "en");
    const current = await readProvidersFile(bundledProvidersPath(), "en");
    const beforeUpgrade = structuredClone(current);
    beforeUpgrade.providers.deepseek.models = beforeUpgrade.providers.deepseek.models.filter((model) => model !== "deepseek-flash");
    mergeProviders(db, beforeUpgrade, true);
    db.close();

    const result = runCli(["providers", "import", "--bundled", "--db", dbPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(bundledProvidersPath().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const zhResult = runCli(["providers", "import", "--bundled", "--db", dbPath], { ...process.env, DISPATCH_LANG: "zh" });
    assert.equal(zhResult.status, 0, zhResult.stderr);
    assert.match(zhResult.stdout, /已合流匯入 providers/);
    assert.match(zhResult.stdout, new RegExp(bundledProvidersPath().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const upgraded = openDb(dbPath, "en");
    assert.equal(
      listModels(upgraded).find((model) => model.provider === "deepseek" && model.model === "deepseek-flash")?.enabled,
      true,
      "--bundled 必須以 bundled=true 合流，讓新 DEFAULT_ENABLED 型號開啟",
    );
    upgraded.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI：providers import --bundled 不接受位置參數", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-providers-bundled-conflict-"));
  try {
    const result = runCli(["providers", "import", "--bundled", bundledProvidersPath(), "--db", path.join(root, "dowafu.db")]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /providers import --bundled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
