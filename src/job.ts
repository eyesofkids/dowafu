import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { now } from "./db.js";
import { m } from "./messages.js";
import { getCommandName } from "./pkg-info.js";
import { getStoredTicket } from "./ticket-store.js";
import { DispatchError } from "./types.js";
import type { Lang } from "./types.js";

export const JOB_STATUSES = [
  "pending_approval",
  "approved",
  "running",
  "completed",
  "failed",
  "interrupted",
  "rejected",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export type Job = {
  id: string;
  ticket: string;
  // null is intentional: jobs queued before schema v5 retain the daemon's startup language.
  lang: Lang | null;
  status: JobStatus;
  created_at: string;
  approved_at: string | null;
  claimed_at: string | null;
  heartbeat_at: string | null;
  finished_at: string | null;
  error: string | null;
  cost_usd: number | null;
};

// Doctor reports these three queue states separately: each means a distinct next
// action (human approval, daemon claim, or paid work in progress).
export type JobQueueCounts = {
  pendingApproval: number;
  approved: number;
  running: number;
};

function one(db: DatabaseSync, sql: string, ...values: Array<string | number | null>): Job | null {
  return (db.prepare(sql).get(...values) as Job | undefined) ?? null;
}

export function getJob(db: DatabaseSync, id: string): Job | null {
  return one(db, "SELECT * FROM jobs WHERE id = ?", id);
}

export function findJobsByIdPrefix(db: DatabaseSync, prefix: string): Job[] {
  return db.prepare("SELECT * FROM jobs WHERE id LIKE ? ORDER BY id").all(`${prefix}%`) as Job[];
}

export function listPendingApprovalJobs(db: DatabaseSync): Job[] {
  return db.prepare("SELECT * FROM jobs WHERE status = 'pending_approval' ORDER BY created_at, id").all() as Job[];
}

// Keep this to one indexed aggregate query rather than loading jobs and counting
// in JavaScript. `idx_jobs_status` covers both the WHERE predicate and status.
export function countQueueJobs(db: DatabaseSync): JobQueueCounts {
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS count
         FROM jobs
        WHERE status IN ('pending_approval', 'approved', 'running')
        GROUP BY status`,
    )
    .all() as Array<{ status: "pending_approval" | "approved" | "running"; count: number }>;
  const counts: JobQueueCounts = { pendingApproval: 0, approved: 0, running: 0 };
  for (const row of rows) {
    if (row.status === "pending_approval") counts.pendingApproval = Number(row.count);
    else if (row.status === "approved") counts.approved = Number(row.count);
    else counts.running = Number(row.count);
  }
  return counts;
}

export function submitJob(db: DatabaseSync, ticket: string, id: string = randomUUID(), lang: Lang | null = null): Job {
  const messageLang = lang ?? "en";
  const stored = getStoredTicket(db, ticket, messageLang);
  if (stored.status !== "sealed") throw new DispatchError(m(messageLang, "ticketDraftRunBlocked", ticket, getCommandName()), 5);
  const createdAt = now();
  db.prepare("INSERT INTO jobs (id, ticket, lang, status, created_at) VALUES (?, ?, ?, 'pending_approval', ?)").run(id, ticket, lang, createdAt);
  return getJob(db, id)!;
}

// A dispatch can leave one __summary__ row plus one row per spoke.  Count distinct result
// keys rather than rows so a single run remains one reminder even when its summary is absent
// or it has many spokes.  The UNION covers both historical CLI keys (ticket name) and queued
// job keys (jobs.id for the same ticket) without double-counting a pathological overlap.
export function countTicketResultRuns(db: DatabaseSync, ticket: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM (
         SELECT job_id FROM results WHERE job_id = ? GROUP BY job_id
         UNION
         SELECT r.job_id
           FROM jobs j JOIN results r ON r.job_id = j.id
          WHERE j.ticket = ?
          GROUP BY r.job_id
       )`,
    )
    .get(ticket, ticket) as { count: number };
  return Number(row.count);
}

export function approveJob(db: DatabaseSync, id: string): Job | null {
  return one(
    db,
    `UPDATE jobs
       SET status = 'approved', approved_at = ?
     WHERE id = ? AND status = 'pending_approval'
     RETURNING *`,
    now(),
    id,
  );
}

// A daemon owns only approvals made after it starts.  Before a new daemon begins
// claiming work, return any older approvals to the explicit human-approval gate.
// Keep this as a single guarded UPDATE: concurrent approval is allowed to remain
// approved for the new daemon, and no other lifecycle state is touched.
export function requeueApprovedJobs(db: DatabaseSync): number {
  return Number(
    db.prepare(
      `UPDATE jobs
         SET status = 'pending_approval', approved_at = NULL
       WHERE status = 'approved'`,
    ).run().changes,
  );
}

export function rejectJob(db: DatabaseSync, id: string): Job | null {
  return one(
    db,
    `UPDATE jobs
       SET status = 'rejected', finished_at = ?
     WHERE id = ? AND status IN ('pending_approval', 'approved')
     RETURNING *`,
    now(),
    id,
  );
}

// This is deliberately one guarded UPDATE.  A second daemon can observe the same
// approved row, but only one can transition it to running and receive it back.
export function claimNextJob(db: DatabaseSync): Job | null {
  const claimedAt = now();
  return one(
    db,
    `UPDATE jobs
       SET status = 'running', claimed_at = ?, heartbeat_at = ?
     WHERE id = (
       SELECT id FROM jobs WHERE status = 'approved' ORDER BY created_at, id LIMIT 1
     ) AND status = 'approved'
     RETURNING *`,
    claimedAt,
    claimedAt,
  );
}

export function heartbeatJob(db: DatabaseSync, id: string): void {
  db.prepare("UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND status = 'running'").run(now(), id);
}

export function finishJob(db: DatabaseSync, id: string, result: { error?: string; costUsd: number | null }): Job | null {
  const status: JobStatus = result.error ? "failed" : "completed";
  return one(
    db,
    `UPDATE jobs
       SET status = ?, finished_at = ?, heartbeat_at = NULL, error = ?, cost_usd = ?
     WHERE id = ? AND status = 'running'
     RETURNING *`,
    status,
    now(),
    result.error ?? null,
    result.costUsd,
    id,
  );
}

// A worker can outlive its daemon: it may persist a spoke result after the first reap has
// marked its job interrupted.  Revisit only a bounded recent window (30 minutes, well over
// the 15-second stale threshold and normal worker shutdown lag), rather than scanning all
// historical interrupted jobs every five-second daemon tick.
export const REAP_INTERRUPTED_LOOKBACK_MS = 30 * 60 * 1_000;

// `resultCost` stays in daemon.ts because that module owns the result-cost calculation used
// by normal finishJob too.  This function owns the state transition and asks its caller for
// that existing calculation only after it finds a real (non-summary) spoke row.
export function reapInterruptedJobs(
  db: DatabaseSync,
  staleBefore: string,
  resultCost: (jobId: string) => number | null,
  reapedAt: string = now(),
): number {
  const revisitAfter = new Date(Date.parse(reapedAt) - REAP_INTERRUPTED_LOOKBACK_MS).toISOString();
  const candidates = db
    .prepare(
      `SELECT id, status FROM jobs
       WHERE (status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?))
          OR (status = 'interrupted' AND finished_at >= ?)
       ORDER BY id`,
    )
    .all(staleBefore, revisitAfter) as Array<{ id: string; status: "running" | "interrupted" }>;
  const hasResult = db.prepare("SELECT 1 FROM results WHERE job_id = ? AND agent != '__summary__' LIMIT 1");
  const complete = db.prepare(
    `UPDATE jobs
       SET status = 'completed', finished_at = ?, heartbeat_at = NULL, cost_usd = ?
     WHERE id = ? AND status IN ('running', 'interrupted')`,
  );
  const interrupt = db.prepare(
    `UPDATE jobs
       SET status = 'interrupted', finished_at = ?, heartbeat_at = NULL
     WHERE id = ? AND status = 'running'`,
  );

  let changes = 0;
  for (const job of candidates) {
    if (hasResult.get(job.id)) {
      changes += Number(complete.run(reapedAt, resultCost(job.id), job.id).changes);
    } else if (job.status === "running") {
      changes += Number(interrupt.run(reapedAt, job.id).changes);
    }
  }
  return changes;
}
