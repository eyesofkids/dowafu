import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDb } from "./db.js";
import { createTicket } from "./ticket-store.js";

test("CLI：approve 拒絕遷移前的 draft job，狀態保持 pending_approval", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-cli-approve-ticket-state-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    const db = openDb(dbPath, "en");
    createTicket(db, "draft-ticket", "# Under review\ntext\n", "en");
    db.prepare("INSERT INTO jobs (id, ticket, status, created_at) VALUES (?, ?, 'pending_approval', ?)")
      .run("legacy-draft-job", "draft-ticket", "2026-09-13T00:00:00.000Z");
    db.close();

    const cliPath = path.join(process.cwd(), "src", "cli.ts");
    const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, "approve", "legacy-draft-job", "--db", dbPath], { encoding: "utf8" });
    assert.equal(result.status, 5, result.stderr);
    assert.match(result.stderr, /draft and its lenses are not frozen/);
    assert.match(result.stderr, /ticket seal draft-ticket --repo-root \./);

    const check = openDb(dbPath, "en");
    assert.equal((check.prepare("SELECT status FROM jobs WHERE id = ?").get("legacy-draft-job") as { status: string }).status, "pending_approval");
    check.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
