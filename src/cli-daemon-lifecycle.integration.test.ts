import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDb } from "./db.js";
import { approveJob, submitJob } from "./job.js";
import { daemonAlive, daemonStatePath } from "./liveness.js";
import { createTicket } from "./ticket-store.js";

const cliPath = path.join(process.cwd(), "src", "cli.ts");

type CliRun = { child: ChildProcess; output: () => string; closed: Promise<number | null> };

function runCli(args: string[]): CliRun {
  const child = spawn(process.execPath, ["--import", "tsx", cliPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  return {
    child,
    output: () => output,
    closed: new Promise((resolve) => child.once("close", resolve)),
  };
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${description}`);
}

test("CLI：serve --restart 先做停止端清理，再啟動並回報兩端張數", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-cli-daemon-lifecycle-"));
  const dbPath = path.join(root, "dowafu.db");
  let first: CliRun | undefined;
  let restarted: CliRun | undefined;
  try {
    const db = openDb(dbPath);
    createTicket(db, "ticket", "# Under review\ntext\n", "en");
    submitJob(db, "ticket", "old-approved");
    approveJob(db, "old-approved");

    first = runCli(["serve", "--db", dbPath, "--http-port", "0"]);
    await waitFor(() => daemonAlive(daemonStatePath(dbPath)).alive, "first daemon heartbeat");
    await waitFor(() => first!.output().includes("1 older approved job(s) returned"), "startup cleanup output");
    assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'old-approved'").get() as { status: string }).status, "pending_approval");

    approveJob(db, "old-approved");
    restarted = runCli(["serve", "--restart", "--yes", "--db", dbPath, "--http-port", "0"]);
    await waitFor(() => restarted!.output().includes("Daemon restarted."), "restart startup output");
    // 第一支 daemon 仍在線，而 daemon 每 500ms 認領一次它在線期間核准的 job——restart 的
    // CLI 啟動（node --import tsx）有時比那個 tick 慢，job 會先被第一支認領。兩種結果都合法，
    // 兩種都驗 DB 一致；「--yes 時照樣退回」的決定性覆蓋在 daemon-observability.test.ts。
    const stopSide = restarted.output().match(/(\d+) approved job\(s\) returned to pending approval\./);
    assert.ok(stopSide, "stop-side cleanup count must be visible");
    assert.match(restarted.output(), /0 older approved job\(s\) returned to pending approval before startup\./, "start-side cleanup count must be visible");
    const row = db.prepare("SELECT status, approved_at FROM jobs WHERE id = 'old-approved'").get() as { status: string; approved_at: string | null };
    if (stopSide[1] === "1") {
      assert.equal(row.status, "pending_approval");
      assert.equal(row.approved_at, null);
    } else {
      assert.equal(stopSide[1], "0", restarted.output());
      assert.notEqual(row.status, "approved");
      assert.notEqual(row.status, "pending_approval");
    }

    const stop = runCli(["serve", "--stop", "--yes", "--db", dbPath]);
    assert.equal(await stop.closed, 0, stop.output());
    assert.equal(await restarted.closed, null, restarted.output());
    assert.equal(await first.closed, null, first.output());
  } finally {
    first?.child.kill("SIGTERM");
    restarted?.child.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});
