import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDb } from "./db.js";
import { approveJob, claimNextJob, countQueueJobs, countTicketResultRuns, findJobsByIdPrefix, finishJob, listPendingApprovalJobs, reapInterruptedJobs, rejectJob, requeueApprovedJobs, submitJob } from "./job.js";
import { createTicket } from "./ticket-store.js";

function resultCost(db: ReturnType<typeof openDb>, jobId: string): number | null {
  return (db.prepare("SELECT SUM(cost_usd) AS cost FROM results WHERE job_id = ?").get(jobId) as { cost: number | null }).cost;
}

function withDb(run: (db: ReturnType<typeof openDb>) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-job-"));
  try {
    run(openDb(path.join(root, "dowafu.db")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function ticket(db: ReturnType<typeof openDb>): void {
  createTicket(db, "sample", "# Under review\ntext\n", "en");
}

test("job：submit 預設待核准，只有 approve 後才可被認領", () => {
  withDb((db) => {
    ticket(db);
    const job = submitJob(db, "sample", "job-1");
    assert.equal(job.status, "pending_approval");
    assert.equal(claimNextJob(db), null);
    assert.equal(approveJob(db, job.id)?.status, "approved");
    assert.equal(claimNextJob(db)?.status, "running");
  });
});

test("job：結果次數聯集 CLI ticket key 與 queue job key，summary 與 spoke 不重複計次", () => {
  withDb((db) => {
    ticket(db);
    // CLI direct run: both rows share the ticket-name key.
    db.prepare("INSERT INTO results (job_id, agent, output) VALUES (?, ?, ?)").run("sample", "__summary__", "summary");
    db.prepare("INSERT INTO results (job_id, agent, output) VALUES (?, ?, ?)").run("sample", "reviewer", "direct result");
    // Queue runs: each job-id key has the same summary-plus-spoke shape.
    for (const id of ["queued-1", "queued-2"]) {
      submitJob(db, "sample", id);
      db.prepare("INSERT INTO results (job_id, agent, output) VALUES (?, ?, ?)").run(id, "__summary__", "summary");
      db.prepare("INSERT INTO results (job_id, agent, output) VALUES (?, ?, ?)").run(id, "reviewer", "queued result");
    }
    assert.equal(countTicketResultRuns(db, "sample"), 3);
  });
});

test("job：佇列計數只查三個工作中狀態，分開回傳且走 status 索引", () => {
  withDb((db) => {
    ticket(db);
    for (const id of ["pending-1", "pending-2", "running", "completed"]) submitJob(db, "sample", id);
    approveJob(db, "running");
    assert.equal(claimNextJob(db)?.id, "running");
    db.prepare("UPDATE jobs SET status = 'completed' WHERE id = 'completed'").run();

    assert.deepEqual(countQueueJobs(db), { pendingApproval: 2, approved: 0, running: 1 });
    const plan = db
      .prepare("EXPLAIN QUERY PLAN SELECT status, COUNT(*) AS count FROM jobs WHERE status IN ('pending_approval', 'approved', 'running') GROUP BY status")
      .all() as Array<{ detail: string }>;
    assert.ok(plan.some((row) => row.detail.includes("idx_jobs_status")), `queue query did not use idx_jobs_status: ${JSON.stringify(plan)}`);
  });
});

test("job：claim 是狀態守衛的原子認領，第二次認領拿不到同一張", () => {
  withDb((db) => {
    ticket(db);
    submitJob(db, "sample", "job-1");
    approveJob(db, "job-1");
    assert.equal(claimNextJob(db)?.id, "job-1");
    assert.equal(claimNextJob(db), null);
  });
});

test("job：claim 的 UPDATE 本身帶 approved 狀態守衛，不能只信前置 SELECT", () => {
  const source = readFileSync(new URL("./job.ts", import.meta.url), "utf8");
  assert.match(source, /\) AND status = 'approved'\s+RETURNING \*/);
});

test("job：requeue 只退回 approved、清 approved_at，且可再次核准", () => {
  withDb((db) => {
    ticket(db);
    for (const id of ["pending", "approved", "running", "completed", "failed", "interrupted", "rejected"]) submitJob(db, "sample", id);
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
    approveJob(db, "approved");

    assert.equal(requeueApprovedJobs(db), 1);
    const rows = db.prepare("SELECT id, status, approved_at FROM jobs ORDER BY id").all() as Array<{ id: string; status: string; approved_at: string | null }>;
    assert.deepEqual(rows.map(({ id, status }) => [id, status]), [
      ["approved", "pending_approval"], ["completed", "completed"], ["failed", "failed"], ["interrupted", "interrupted"],
      ["pending", "pending_approval"], ["rejected", "rejected"], ["running", "running"],
    ]);
    assert.equal(rows.find((row) => row.id === "approved")?.approved_at, null);
    assert.equal(approveJob(db, "approved")?.status, "approved");
  });
});

test("job：reject 是終態，之後不能核准或認領", () => {
  withDb((db) => {
    ticket(db);
    submitJob(db, "sample", "job-1");
    assert.equal(rejectJob(db, "job-1")?.status, "rejected");
    assert.equal(approveJob(db, "job-1"), null);
    assert.equal(claimNextJob(db), null);
  });
});

test("job：finish 只接受 running，保留 worker 算出的成本", () => {
  withDb((db) => {
    ticket(db);
    submitJob(db, "sample", "job-1");
    approveJob(db, "job-1");
    assert.equal(finishJob(db, "job-1", { costUsd: 4 }), null);
    claimNextJob(db);
    const done = finishJob(db, "job-1", { costUsd: 4 });
    assert.equal(done?.status, "completed");
    assert.equal(done?.cost_usd, 4);
  });
});

test("job：reap 將過期 running 標 interrupted，絕不把已花 cost_usd 歸零", () => {
  withDb((db) => {
    ticket(db);
    submitJob(db, "sample", "job-1");
    approveJob(db, "job-1");
    claimNextJob(db);
    db.prepare("UPDATE jobs SET heartbeat_at = ?, cost_usd = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", 3.5, "job-1");
    assert.equal(reapInterruptedJobs(db, "2020-01-01T00:00:00.000Z", (jobId) => resultCost(db, jobId)), 1);
    const row = db.prepare("SELECT status, cost_usd FROM jobs WHERE id = ?").get("job-1") as { status: string; cost_usd: number };
    assert.equal(row.status, "interrupted");
    assert.equal(row.cost_usd, 3.5);
  });
});

test("job：reap 有非 summary 結果時補 completed 與結果成本，重跑是冪等的", () => {
  withDb((db) => {
    ticket(db);
    submitJob(db, "sample", "late-result");
    approveJob(db, "late-result");
    claimNextJob(db);
    db.prepare("UPDATE jobs SET heartbeat_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", "late-result");
    db.prepare("INSERT INTO results (job_id, agent, output, cost_usd) VALUES (?, ?, ?, ?)").run("late-result", "reviewer", "done", 0.016330552);
    db.prepare("INSERT INTO results (job_id, agent, output, cost_usd) VALUES (?, ?, ?, ?)").run("late-result", "__summary__", "summary", null);

    const reapedAt = "2026-09-09T00:00:00.000Z";
    assert.equal(reapInterruptedJobs(db, "2020-01-01T00:00:00.000Z", (jobId) => resultCost(db, jobId), reapedAt), 1);
    const row = db.prepare("SELECT status, cost_usd FROM jobs WHERE id = ?").get("late-result") as { status: string; cost_usd: number };
    assert.deepEqual({ ...row }, { status: "completed", cost_usd: 0.016330552 });
    assert.equal(reapInterruptedJobs(db, "2020-01-01T00:00:00.000Z", (jobId) => resultCost(db, jobId), reapedAt), 0);
    assert.deepEqual(
      { ...(db.prepare("SELECT status, cost_usd FROM jobs WHERE id = ?").get("late-result") as { status: string; cost_usd: number }) },
      { status: "completed", cost_usd: 0.016330552 },
    );
  });
});

test("job：reap 沒有任何 spoke 結果時仍標 interrupted，成本保持 NULL", () => {
  withDb((db) => {
    ticket(db);
    submitJob(db, "sample", "actually-interrupted");
    approveJob(db, "actually-interrupted");
    claimNextJob(db);
    db.prepare("UPDATE jobs SET heartbeat_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", "actually-interrupted");
    assert.equal(reapInterruptedJobs(db, "2020-01-01T00:00:00.000Z", (jobId) => resultCost(db, jobId)), 1);
    assert.deepEqual(
      { ...(db.prepare("SELECT status, cost_usd FROM jobs WHERE id = ?").get("actually-interrupted") as { status: string; cost_usd: null }) },
      { status: "interrupted", cost_usd: null },
    );
  });
});

test("job：reap 只回看最近的 interrupted，晚到結果會修正、過窗歷史不會被掃", () => {
  withDb((db) => {
    ticket(db);
    for (const id of ["recent-interrupted", "old-interrupted"]) {
      submitJob(db, "sample", id);
      approveJob(db, id);
      claimNextJob(db);
    }
    db.prepare("UPDATE jobs SET status = 'interrupted', finished_at = ?, heartbeat_at = NULL WHERE id = ?").run("2026-09-08T23:45:00.000Z", "recent-interrupted");
    db.prepare("UPDATE jobs SET status = 'interrupted', finished_at = ?, heartbeat_at = NULL WHERE id = ?").run("2026-09-08T23:00:00.000Z", "old-interrupted");
    db.prepare("INSERT INTO results (job_id, agent, output, cost_usd) VALUES (?, ?, ?, ?)").run("recent-interrupted", "reviewer", "late", 2.5);
    db.prepare("INSERT INTO results (job_id, agent, output, cost_usd) VALUES (?, ?, ?, ?)").run("old-interrupted", "reviewer", "too old", 9.9);
    assert.equal(reapInterruptedJobs(db, "2026-09-09T00:00:00.000Z", (jobId) => resultCost(db, jobId), "2026-09-09T00:00:00.000Z"), 1);
    assert.deepEqual(
      { ...(db.prepare("SELECT status, cost_usd FROM jobs WHERE id = ?").get("recent-interrupted") as { status: string; cost_usd: number }) },
      { status: "completed", cost_usd: 2.5 },
    );
    assert.deepEqual(
      { ...(db.prepare("SELECT status, cost_usd FROM jobs WHERE id = ?").get("old-interrupted") as { status: string; cost_usd: null }) },
      { status: "interrupted", cost_usd: null },
    );
  });
});

test("job：submit 拒絕不存在的 DB ticket", () => {
  withDb((db) => assert.throws(() => submitJob(db, "missing", "job-1"), /ticket does not exist/));
});

test("job：id 前綴查詢保留所有狀態的排序命中，pending 清單只取待核准項目", () => {
  withDb((db) => {
    ticket(db);
    submitJob(db, "sample", "abc-002");
    submitJob(db, "sample", "abc-001");
    submitJob(db, "sample", "other-001");
    approveJob(db, "abc-002");
    const prefixed = findJobsByIdPrefix(db, "abc-");
    assert.deepEqual(prefixed.map((job) => [job.id, job.status]), [["abc-001", "pending_approval"], ["abc-002", "approved"]]);
    assert.deepEqual(listPendingApprovalJobs(db).map((job) => job.id), ["abc-001", "other-001"]);
  });
});
