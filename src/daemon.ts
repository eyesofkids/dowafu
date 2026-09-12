import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { hasAnyActiveToken } from "./api-token.js";
import { defaultDbPath, openDb } from "./db.js";
import { claimNextJob, finishJob, heartbeatJob, reapInterruptedJobs, requeueApprovedJobs, type Job } from "./job.js";
import { DAEMON_STALE_MS, daemonAlive, daemonStatePath, writeHeartbeat } from "./liveness.js";
import { createHttpServer, DEFAULT_HTTP_PORT } from "./mcp/http.js";
import { maskString } from "./mask.js";
import { m } from "./messages.js";
import type { Lang } from "./types.js";

export const DEFAULT_DAEMON_CONCURRENCY = 2;
export const DAEMON_TICK_MS = 500;
export const DAEMON_HEARTBEAT_MS = 5_000;
// B（gaps #6）：reap 先前只在 daemon 啟動那一刻跑一次，所以 daemon 死了又沒人重開，
// job 會**永遠**停在 running——只讀 status 的輪詢器等不到終態。
// （既有那條測試的名字寫「不讓**重啟後**狀態永遠卡住」，它保證的正是「有重啟才不卡住」。）
// 週期跑不會誤傷自己的 job：worker 的心跳每 2 秒寫一次，門檻是 15 秒，中間有 7 倍餘裕。
export const DAEMON_REAP_MS = 5_000;

export type ExecuteJob = (job: Job) => Promise<{ error?: string }>;

export type Daemon = { tick: () => void; stop: () => void; running: () => number };

export function resultCost(db: DatabaseSync, jobId: string): number | null {
  const row = db.prepare("SELECT SUM(cost_usd) AS cost FROM results WHERE job_id = ?").get(jobId) as { cost: number | null };
  return row.cost;
}

export function createDaemon(
  db: DatabaseSync,
  options: {
    dbPath: string;
    maxConcurrent?: number;
    execute: ExecuteJob;
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
    now?: () => number;
    pid?: number;
  },
): Daemon {
  const maxConcurrent = options.maxConcurrent ?? DEFAULT_DAEMON_CONCURRENCY;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("daemon concurrency must be a positive integer");
  const statePath = daemonStatePath(options.dbPath);
  const intervals: ReturnType<typeof setInterval>[] = [];
  const running = new Set<string>();
  const nowMs = options.now ?? Date.now;
  const schedule = options.setInterval ?? setInterval;
  const cancel = options.clearInterval ?? clearInterval;
  const beat = () => writeHeartbeat(statePath, options.pid);

  const run = (job: Job) => {
    running.add(job.id);
    const jobHeartbeat = schedule(() => heartbeatJob(db, job.id), 2_000);
    void options
      .execute(job)
      .then((outcome) => finishJob(db, job.id, { error: outcome.error, costUsd: resultCost(db, job.id) }))
      .catch((err: unknown) => finishJob(db, job.id, { error: String(err), costUsd: resultCost(db, job.id) }))
      .finally(() => {
        cancel(jobHeartbeat);
        running.delete(job.id);
      });
  };
  const tick = () => {
    while (running.size < maxConcurrent) {
      const job = claimNextJob(db);
      if (!job) break;
      run(job);
    }
  };

  // staleBefore 每次重算——先前是在啟動時算一次的區域變數，週期化之後若沿用那個值，
  // 跑久了門檻會離現在越來越遠，最後等於不再 reap。
  const reap = () => {
    const reapedAt = new Date(nowMs()).toISOString();
    return reapInterruptedJobs(db, new Date(nowMs() - DAEMON_STALE_MS).toISOString(), (jobId) => resultCost(db, jobId), reapedAt);
  };
  reap();
  beat();
  intervals.push(schedule(beat, DAEMON_HEARTBEAT_MS), schedule(tick, DAEMON_TICK_MS), schedule(reap, DAEMON_REAP_MS));
  return {
    tick,
    stop: () => intervals.forEach(cancel),
    running: () => running.size,
  };
}

// 8 KiB retains several complete diagnostic lines while bounding daemon memory and DB error
// rows; CLI failures normally put their actionable summary at the end of stderr.
export const WORKER_STDERR_TAIL_BYTES = 8 * 1024;

export type RunCliJobDeps = {
  spawn: typeof spawn;
  stderr: Pick<NodeJS.WritableStream, "write">;
};

const DEFAULT_RUN_CLI_JOB_DEPS: RunCliJobDeps = { spawn, stderr: process.stderr };

export function workerFailureMessage(
  lang: Lang,
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  const detail = maskString(stderr.trim());
  if (signal) return detail ? m(lang, "daemonWorkerTerminatedDetail", signal, detail) : m(lang, "daemonWorkerTerminated", signal);
  const exitCode = code ?? "unknown";
  return detail ? m(lang, "daemonWorkerExitedDetail", exitCode, detail) : m(lang, "daemonWorkerExited", exitCode);
}

export function runCliJob(
  job: Job,
  dbPath: string,
  lang: Lang = "en",
  deps: RunCliJobDeps = DEFAULT_RUN_CLI_JOB_DEPS,
): Promise<{ error?: string }> {
  const sourceMode = fileURLToPath(import.meta.url).endsWith(".ts");
  const cliPath = fileURLToPath(new URL(sourceMode ? "./cli.ts" : "./cli.js", import.meta.url));
  // v5 jobs carry an explicit language; rows queued by an older client keep NULL and retain
  // the daemon-startup fallback.  Pass the resolved value to the child so its prompt and
  // stdout use the same language as the daemon's own failure message.
  const jobLang = job.lang ?? lang;
  const args = sourceMode
    ? ["--import", "tsx", cliPath, "--ticket", job.ticket, "--yes", "--job-id", job.id, "--db", dbPath, "--lang", jobLang]
    : [cliPath, "--ticket", job.ticket, "--yes", "--job-id", job.id, "--db", dbPath, "--lang", jobLang];
  return new Promise((resolve) => {
    const child: ChildProcess = deps.spawn(process.execPath, args, { stdio: ["inherit", "inherit", "pipe"], env: process.env });
    let stderrTail = Buffer.alloc(0);
    child.stderr?.on("data", (chunk: Buffer) => {
      // Preserve the daemon's own stderr/log stream while retaining a bounded tail for jobs.error.
      deps.stderr.write(chunk);
      stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-WORKER_STDERR_TAIL_BYTES);
    });
    child.once("error", (err) => resolve({ error: m(jobLang, "daemonWorkerSpawnFailed", maskString(String(err))) }));
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({});
      else resolve({ error: workerFailureMessage(jobLang, code, signal, stderrTail.toString("utf8")) });
    });
  });
}

export type StopDaemonOutcome =
  | { status: "not_running"; reason: "heartbeat_missing" | "heartbeat_stale" | "pid_gone" }
  | { status: "cancelled"; runningJobs: number; approvedJobs: number }
  | { status: "pid_not_dowafu"; pid: number }
  | { status: "signal_failed"; pid: number; requeuedApprovedJobs: number }
  | { status: "stopped"; pid: number; requeuedApprovedJobs: number }
  | { status: "restarted"; pid: number };

export type StopDaemonDeps = {
  liveness: (statePath: string) => ReturnType<typeof daemonAlive>;
  countRunningJobs: (dbPath: string) => number;
  countApprovedJobs: (dbPath: string) => number;
  requeueApprovedJobs: (dbPath: string) => number;
  processCommand: (pid: number) => string | null;
  processExists: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  wait: (ms: number) => Promise<void>;
};

const STOP_CHECK_INTERVAL_MS = 100;
const STOP_CHECK_ATTEMPTS = 10;
const STOP_RESTART_WAIT_MS = 500;

const DEFAULT_STOP_DAEMON_DEPS: StopDaemonDeps = {
  liveness: (statePath) => daemonAlive(statePath),
  countRunningJobs: (dbPath) => {
    const row = openDb(dbPath).prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'running'").get() as { count: number };
    return row.count;
  },
  countApprovedJobs: (dbPath) => {
    const row = openDb(dbPath).prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'approved'").get() as { count: number };
    return row.count;
  },
  requeueApprovedJobs: (dbPath) => requeueApprovedJobs(openDb(dbPath)),
  processCommand: (pid) => {
    try {
      return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return null;
    }
  },
  processExists: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  kill: (pid, signal) => process.kill(pid, signal),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function isDowafuProcess(command: string | null): boolean {
  return command !== null && /(?:\bdowafu\b|\bcli\.(?:ts|js)\b)/.test(command);
}

export async function stopDaemon(
  dbPath: string = defaultDbPath(),
  options: {
    force?: boolean;
    confirmRunningJobs?: (count: number) => Promise<boolean>;
    confirmApprovedJobs?: (count: number) => Promise<boolean>;
    deps?: StopDaemonDeps;
  } = {},
): Promise<StopDaemonOutcome> {
  const deps = options.deps ?? DEFAULT_STOP_DAEMON_DEPS;
  const statePath = daemonStatePath(dbPath);
  const initial = deps.liveness(statePath);
  if (!initial.alive) return { status: "not_running", reason: initial.reason };

  if (!isDowafuProcess(deps.processCommand(initial.pid))) return { status: "pid_not_dowafu", pid: initial.pid };
  const runningJobs = deps.countRunningJobs(dbPath);
  const approvedJobs = deps.countApprovedJobs(dbPath);
  const confirmedRunning = runningJobs === 0 || options.force || await (options.confirmRunningJobs?.(runningJobs) ?? Promise.resolve(false));
  // Ask independently even when the stop confirmation was declined.  A running
  // worker warning and an old-approval cleanup warning describe different risks.
  const confirmedApproved = approvedJobs === 0 || options.force || await (options.confirmApprovedJobs?.(approvedJobs) ?? Promise.resolve(false));
  if (!confirmedRunning || !confirmedApproved) return { status: "cancelled", runningJobs, approvedJobs };

  const requeuedApprovedJobs = deps.requeueApprovedJobs(dbPath);
  try {
    deps.kill(initial.pid, "SIGTERM");
  } catch {
    return { status: "signal_failed", pid: initial.pid, requeuedApprovedJobs };
  }

  for (let attempt = 0; attempt < STOP_CHECK_ATTEMPTS; attempt++) {
    await deps.wait(STOP_CHECK_INTERVAL_MS);
    if (!deps.liveness(statePath).alive && !deps.processExists(initial.pid)) {
      await deps.wait(STOP_RESTART_WAIT_MS);
      return deps.liveness(statePath).alive
        ? { status: "restarted", pid: initial.pid }
        : { status: "stopped", pid: initial.pid, requeuedApprovedJobs };
    }
  }
  return { status: "signal_failed", pid: initial.pid, requeuedApprovedJobs };
}

export type ServeResult = Daemon & { httpPort: number; hasActiveToken: boolean; requeuedApprovedJobs: number };

function bindHttp(db: DatabaseSync, dbPath: string, httpPort: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    // 工單 C §零裁示 1：只綁 127.0.0.1，沒有 --host——公開與否是 tunnel 的事。
    const server = createHttpServer({ db, dbPath });
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(httpPort, "127.0.0.1");
  });
}

// 工單 C §D：HTTP 起不來時，整個 serve 失敗（不降級成「只有 stdio 能用的 daemon」）。
// worker／心跳只在 HTTP 成功綁定之後才建立，兩者要嘛一起活、要嘛都不起——一個活著但另一個
// 靜默死掉，正是「失敗長得像成功」的形態，本票明文選擇不要那樣。
//
// `serve` 本身刻意不是 async function：daemon-already-running 那個守衛必須維持同步拋出
// （既有測試 `assert.throws(() => serve(dbPath), ...)` 依賴這一點），只有 HTTP 綁定之後
// 那段才回傳 Promise。
export function serve(
  dbPath: string = defaultDbPath(),
  maxConcurrent: number = Number(process.env.DOWAFU_MAX_CONCURRENT ?? DEFAULT_DAEMON_CONCURRENCY),
  httpPort: number = Number(process.env.DOWAFU_HTTP_PORT ?? DEFAULT_HTTP_PORT),
  lang: Lang = "en",
): Promise<ServeResult> {
  const state = daemonAlive(daemonStatePath(dbPath));
  if (state.alive) throw new Error(`daemon already running (pid ${state.pid})`);
  const db = openDb(dbPath);
  return bindHttp(db, dbPath, httpPort).then((httpServer) => {
    let daemon: Daemon;
    let requeuedApprovedJobs: number;
    try {
      requeuedApprovedJobs = requeueApprovedJobs(db);
      daemon = createDaemon(db, { dbPath, maxConcurrent, execute: (job) => runCliJob(job, dbPath, lang) });
    } catch (err) {
      httpServer.close();
      throw err;
    }
    process.on("SIGINT", () => {
      daemon.stop();
      httpServer.close();
      process.exit(0);
    });
    const address = httpServer.address();
    const boundPort = typeof address === "object" && address ? address.port : httpPort;
    return {
      ...daemon,
      stop: () => {
        daemon.stop();
        httpServer.close();
      },
      httpPort: boundPort,
      hasActiveToken: hasAnyActiveToken(db),
      requeuedApprovedJobs,
    };
  });
}
