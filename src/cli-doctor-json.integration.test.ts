import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { openDb } from "./db.js";
import { approveJob, claimNextJob, submitJob } from "./job.js";
import { createTicket } from "./ticket-store.js";

test("CLI：--doctor --json 只輸出同一份結構化判定，保留 daemon 三態", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-doctor-json-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    const cliPath = path.join(process.cwd(), "src", "cli.ts");
    const jsonRun = spawnSync(process.execPath, ["--import", "tsx", cliPath, "--doctor", "--json", "--db", dbPath], { encoding: "utf8" });
    assert.equal(jsonRun.status, 0, jsonRun.stderr);
    const report = JSON.parse(jsonRun.stdout) as {
      daemon: { alive: boolean; reason?: string };
      apiKeys: Array<{ maskedTail: string | null }>;
      queue: { pendingApproval: number; approved: number; running: number };
    };
    assert.deepEqual(report.daemon, { alive: false, reason: "heartbeat_missing" });
    assert.ok(report.apiKeys.every((row) => row.maskedTail === null || row.maskedTail.startsWith("…")));
    assert.deepEqual(report.queue, { pendingApproval: 0, approved: 0, running: 0 });

    const humanRun = spawnSync(process.execPath, ["--import", "tsx", cliPath, "--doctor", "--db", dbPath], { encoding: "utf8" });
    assert.equal(humanRun.status, 0, humanRun.stderr);
    assert.match(humanRun.stdout, /heartbeat_missing/);
    assert.doesNotMatch(jsonRun.stdout, /Daemon\s/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI：--doctor 的 JSON camelCase 佇列契約與文字版三態來自同一份 DB 計數", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-doctor-queue-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    const db = openDb(dbPath, "en");
    createTicket(db, "sample", "# Under review\ntext\n", "en");
    for (const id of ["pending-1", "pending-2", "running"]) submitJob(db, "sample", id);
    approveJob(db, "running");
    assert.equal(claimNextJob(db)?.id, "running");
    db.close();

    const cliPath = path.join(process.cwd(), "src", "cli.ts");
    const jsonRun = spawnSync(process.execPath, ["--import", "tsx", cliPath, "--doctor", "--json", "--db", dbPath], { encoding: "utf8" });
    assert.equal(jsonRun.status, 0, jsonRun.stderr);
    const json = JSON.parse(jsonRun.stdout) as { queue: { pendingApproval: number; approved: number; running: number } };
    assert.deepEqual(json.queue, { pendingApproval: 2, approved: 0, running: 1 });
    assert.deepEqual(Object.keys(json.queue), ["pendingApproval", "approved", "running"]);

    const humanRun = spawnSync(process.execPath, ["--import", "tsx", cliPath, "--doctor", "--db", dbPath], { encoding: "utf8" });
    assert.equal(humanRun.status, 0, humanRun.stderr);
    assert.match(humanRun.stdout, /Queue\s+pending approval 2; approved 0; running 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI：doctor 開不起 DB 仍回傳零佇列 JSON 而不崩潰", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-doctor-queue-fail-"));
  try {
    const blocker = path.join(root, "not-a-directory");
    writeFileSync(blocker, "block database parent");
    const cliPath = path.join(process.cwd(), "src", "cli.ts");
    const jsonRun = spawnSync(process.execPath, ["--import", "tsx", cliPath, "--doctor", "--json", "--db", path.join(blocker, "dowafu.db")], { encoding: "utf8" });
    assert.equal(jsonRun.status, 0, jsonRun.stderr);
    const json = JSON.parse(jsonRun.stdout) as { models: { ok: boolean }; queue: { pendingApproval: number; approved: number; running: number } };
    assert.equal(json.models.ok, false);
    assert.deepEqual(json.queue, { pendingApproval: 0, approved: 0, running: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
