import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("CLI：--doctor --json 只輸出同一份結構化判定，保留 daemon 三態", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-doctor-json-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    const cliPath = path.join(process.cwd(), "src", "cli.ts");
    const jsonRun = spawnSync(process.execPath, ["--import", "tsx", cliPath, "--doctor", "--json", "--db", dbPath], { encoding: "utf8" });
    assert.equal(jsonRun.status, 0, jsonRun.stderr);
    const report = JSON.parse(jsonRun.stdout) as { daemon: { alive: boolean; reason?: string }; apiKeys: Array<{ maskedTail: string | null }> };
    assert.deepEqual(report.daemon, { alive: false, reason: "heartbeat_missing" });
    assert.ok(report.apiKeys.every((row) => row.maskedTail === null || row.maskedTail.startsWith("…")));

    const humanRun = spawnSync(process.execPath, ["--import", "tsx", cliPath, "--doctor", "--db", dbPath], { encoding: "utf8" });
    assert.equal(humanRun.status, 0, humanRun.stderr);
    assert.match(humanRun.stdout, /heartbeat_missing/);
    assert.doesNotMatch(jsonRun.stdout, /Daemon\s/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
