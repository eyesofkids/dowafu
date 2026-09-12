import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { issueToken } from "./api-token.js";
import { createDaemon, serve } from "./daemon.js";
import { openDb } from "./db.js";
import { approveJob, claimNextJob, finishJob, rejectJob, submitJob } from "./job.js";
import { daemonStatePath } from "./liveness.js";
import { createTicket } from "./ticket-store.js";

test("daemon：最多同時跑設定上限，完成後寫 completed", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-daemon-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    const db = openDb(dbPath);
    createTicket(db, "one", "# Under review\ntext\n", "en");
    createTicket(db, "two", "# Under review\ntext\n", "en");
    submitJob(db, "one", "one");
    submitJob(db, "two", "two");
    approveJob(db, "one");
    approveJob(db, "two");
    const started: string[] = [];
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const daemon = createDaemon(db, {
      dbPath,
      maxConcurrent: 1,
      execute: async (job) => {
        started.push(job.id);
        await waiting;
        return {};
      },
    });
    daemon.tick();
    assert.deepEqual(started, ["one"]);
    assert.equal(daemon.running(), 1);
    release!();
    await new Promise((resolve) => setImmediate(resolve));
    daemon.tick();
    assert.deepEqual(started, ["one", "two"]);
    assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'one'").get() as { status: string }).status, "completed");
    daemon.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon：啟動時真的 reap 過期 running job，不讓重啟後狀態永遠卡住", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-daemon-reap-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    const db = openDb(dbPath);
    createTicket(db, "stale", "# Under review\ntext\n", "en");
    submitJob(db, "stale", "stale-job");
    approveJob(db, "stale-job");
    claimNextJob(db);
    db.prepare("UPDATE jobs SET heartbeat_at = ?, cost_usd = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", 3.5, "stale-job");
    const daemon = createDaemon(db, { dbPath, now: () => Date.parse("2020-01-01T00:00:00.000Z"), execute: async () => ({}) });
    try {
      const row = db.prepare("SELECT status, cost_usd FROM jobs WHERE id = 'stale-job'").get() as { status: string; cost_usd: number };
      assert.deepEqual({ ...row }, { status: "interrupted", cost_usd: 3.5 });
    } finally {
      daemon.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// B（gaps #6）：reap 先前**只在啟動那一刻**跑一次。上面那條測試的名字寫「不讓重啟後狀態
// 永遠卡住」——它保證的正是「有重啟才不卡住」。daemon 死了又沒人重開，job 會永遠停在
// running，只讀 status 的輪詢器等不到終態。這條鎖住「它也會週期性地跑」。
//
// 時鐘要跟著走：staleBefore 先前是啟動時算一次的區域變數，週期化之後若沿用那個值，
// 跑久了門檻會離現在越來越遠，最後等於不再 reap。所以這裡讓 now 在兩次呼叫之間前進，
// 而 job 是在 daemon 啟動**之後**才變成過期的——啟動那次 reap 抓不到它。
test("daemon：reap 是週期性的，不是只在啟動時跑一次", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-daemon-reap-periodic-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    const db = openDb(dbPath);
    createTicket(db, "stale", "# Under review\ntext\n", "en");
    submitJob(db, "stale", "stale-job");
    approveJob(db, "stale-job");
    claimNextJob(db);
    db.prepare("UPDATE jobs SET heartbeat_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", "stale-job");

    const callbacks: Array<() => void> = [];
    const schedule = ((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    // 啟動時的「現在」比心跳還早，所以那一次 reap 抓不到它——狀態必須還是 running。
    let nowMs = Date.parse("2019-01-01T00:00:00.000Z");
    const daemon = createDaemon(db, {
      dbPath,
      execute: async () => ({}),
      now: () => nowMs,
      setInterval: schedule,
      clearInterval: () => {},
    });
    try {
      assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'stale-job'").get() as { status: string }).status, "running");
      // 時間往前走，然後只跑排程進去的那些 callback——其中必須有一個會 reap。
      nowMs = Date.parse("2026-01-01T00:00:00.000Z");
      for (const callback of callbacks) callback();
      assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'stale-job'").get() as { status: string }).status, "interrupted");
    } finally {
      daemon.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon：worker 在 daemon 死後才落結果，下一次 reap 仍會回填 completed 與成本", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-daemon-late-worker-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    const db = openDb(dbPath);
    createTicket(db, "late", "# Under review\ntext\n", "en");
    submitJob(db, "late", "late-worker-job");
    approveJob(db, "late-worker-job");
    claimNextJob(db);
    db.prepare("UPDATE jobs SET heartbeat_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", "late-worker-job");
    const callbacks: Array<() => void> = [];
    const schedule = ((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    const nowMs = Date.parse("2026-09-09T00:00:00.000Z");
    const daemon = createDaemon(db, { dbPath, execute: async () => ({}), now: () => nowMs, setInterval: schedule, clearInterval: () => {} });
    try {
      assert.equal((db.prepare("SELECT status FROM jobs WHERE id = ?").get("late-worker-job") as { status: string }).status, "interrupted");
      // This is the fake worker's delayed write after its parent daemon has stopped.
      db.prepare("INSERT INTO results (job_id, agent, output, cost_usd) VALUES (?, ?, ?, ?)").run("late-worker-job", "reviewer", "late result", 0.016330552);
      callbacks[2](); // beat, tick, reap
      assert.deepEqual(
        { ...(db.prepare("SELECT status, cost_usd FROM jobs WHERE id = ?").get("late-worker-job") as { status: string; cost_usd: number }) },
        { status: "completed", cost_usd: 0.016330552 },
      );
    } finally {
      daemon.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon：啟動立即寫心跳，之後排程持續更新", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-daemon-heartbeat-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    const callbacks: Array<() => void> = [];
    const schedule = ((callback: () => void) => {
      callbacks.push(callback);
      return callbacks.length as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    const daemon = createDaemon(openDb(dbPath), {
      dbPath,
      pid: 4321,
      execute: async () => ({}),
      setInterval: schedule,
      clearInterval: () => {},
    });
    const firstBeat = JSON.parse(readFileSync(daemonStatePath(dbPath), "utf8")) as { pid: number; at: number };
    assert.equal(firstBeat.pid, 4321);
    assert.equal(typeof firstBeat.at, "number");
    callbacks[0]();
    assert.equal(JSON.parse(readFileSync(daemonStatePath(dbPath), "utf8")).pid, 4321);
    daemon.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon：worker 失敗會寫 failed 與錯誤", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-daemon-failed-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    const db = openDb(dbPath);
    createTicket(db, "broken", "# Under review\ntext\n", "en");
    submitJob(db, "broken", "broken-job");
    approveJob(db, "broken-job");
    const daemon = createDaemon(db, { dbPath, execute: async () => ({ error: "worker broke" }) });
    try {
      daemon.tick();
      await new Promise((resolve) => setImmediate(resolve));
      const row = db.prepare("SELECT status, error FROM jobs WHERE id = 'broken-job'").get() as { status: string; error: string };
      assert.deepEqual({ ...row }, { status: "failed", error: "worker broke" });
    } finally {
      daemon.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon：重複啟動給 pid 的人類可讀錯誤，不是 stack trace", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-daemon-duplicate-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    const db = openDb(dbPath);
    createTicket(db, "sample", "# Under review\ntext\n", "en");
    submitJob(db, "sample", "old-approved");
    approveJob(db, "old-approved");
    const state = daemonStatePath(dbPath);
    writeFileSync(state, JSON.stringify({ pid: process.pid, at: Date.now() }));
    assert.throws(() => serve(dbPath), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, `daemon already running (pid ${process.pid})`);
      assert.doesNotMatch(err.stack ?? "", /EADDRINUSE/);
      return true;
    });
    assert.equal((db.prepare("SELECT status FROM jobs WHERE id = 'old-approved'").get() as { status: string }).status, "approved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon：serve 守衛通過後退回舊 approved，保留其他狀態且可重新核准執行", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-daemon-start-clean-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    const db = openDb(dbPath);
    createTicket(db, "sample", "# Under review\ntext\n", "en");
    for (const id of ["pending", "old-approved", "running", "completed", "failed", "interrupted", "rejected"]) submitJob(db, "sample", id);
    approveJob(db, "running");
    claimNextJob(db);
    approveJob(db, "completed");
    claimNextJob(db);
    finishJob(db, "completed", { costUsd: null });
    approveJob(db, "failed");
    claimNextJob(db);
    finishJob(db, "failed", { error: "broken", costUsd: null });
    approveJob(db, "interrupted");
    claimNextJob(db);
    db.prepare("UPDATE jobs SET status = 'interrupted' WHERE id = 'interrupted'").run();
    rejectJob(db, "rejected");
    approveJob(db, "old-approved");

    const result = await serve(dbPath, 1, 0);
    try {
      assert.equal(result.requeuedApprovedJobs, 1);
      const rows = db.prepare("SELECT id, status, approved_at FROM jobs ORDER BY id").all() as Array<{ id: string; status: string; approved_at: string | null }>;
      assert.deepEqual(rows.map(({ id, status }) => [id, status]), [
        ["completed", "completed"], ["failed", "failed"], ["interrupted", "interrupted"], ["old-approved", "pending_approval"],
        ["pending", "pending_approval"], ["rejected", "rejected"], ["running", "running"],
      ]);
      assert.equal(rows.find((row) => row.id === "old-approved")?.approved_at, null);
      assert.equal(claimNextJob(db), null, "startup must not execute approvals from before this daemon");
      assert.equal(approveJob(db, "old-approved")?.status, "approved");
      const started: string[] = [];
      const daemon = createDaemon(db, { dbPath, execute: async (job) => { started.push(job.id); return {}; } });
      try {
        daemon.tick();
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(started, ["old-approved"]);
      } finally {
        daemon.stop();
      }
    } finally {
      result.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 工單 C §F-6：把 daemon 起 HTTP 的那一行拿掉，這條測試必須紅——http.ts 的單元測試
// 只證明 handler 本身對，證明不了 serve() 真的把它接上去。票 A／票 B 的驗收都撞過這個家族。
test("daemon：serve 真的把 HTTP 接上去，不是只有 worker／心跳", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-daemon-http-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    openDb(dbPath);
    const result = await serve(dbPath, 1, 0);
    try {
      assert.equal(result.hasActiveToken, false);
      const res = await fetch(`http://127.0.0.1:${result.httpPort}/mcp`, { method: "GET" });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "POST");
    } finally {
      result.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon：serve 回報是否已發過 token（B-1 #6 的資料來源）", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-daemon-http-token-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    const db = openDb(dbPath);
    issueToken(db, "laptop");
    const result = await serve(dbPath, 1, 0);
    try {
      assert.equal(result.hasActiveToken, true);
    } finally {
      result.stop();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// 工單 C §D：埠被占用時整個 serve 失敗，不降級成「只有 stdio 能用的 daemon」——
// 用心跳檔沒被寫出來，證明 worker 真的沒有半啟動（beat() 在 createDaemon 建立時就同步寫檔）。
test("daemon：埠被占用時整個 serve 失敗，worker 不半啟動", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-daemon-http-conflict-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    openDb(dbPath);
    const occupied = createServer(() => {});
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", () => resolve()));
    const address = occupied.address();
    const port = typeof address === "object" && address ? address.port : 0;
    try {
      await assert.rejects(() => serve(dbPath, 1, port));
      assert.equal(existsSync(daemonStatePath(dbPath)), false);
    } finally {
      occupied.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
