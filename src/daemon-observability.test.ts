import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ChildProcess, spawn } from "node:child_process";
import { runCliJob, stopDaemon, workerFailureMessage, type StopDaemonDeps } from "./daemon.js";
import { registerSecrets } from "./mask.js";
import { m } from "./messages.js";
import type { Job } from "./job.js";

const JOB: Job = {
  id: "job-1", ticket: "ticket-1", lang: "zh", status: "running", created_at: "2026-09-08T00:00:00.000Z", approved_at: null,
  claimed_at: null, heartbeat_at: null, finished_at: null, error: null, cost_usd: null,
};

test("runCliJob：stderr tee 後遮罩寫入 error，並保留 exit code", async () => {
  const events = new EventEmitter();
  const stderrEvents = new EventEmitter();
  const child = Object.assign(events, { stderr: stderrEvents }) as unknown as ChildProcess;
  const written: string[] = [];
  let receivedStdio: unknown;
  let receivedArgs: unknown;
  registerSecrets(["stored-secret-token"]);
  try {
    const outcome = runCliJob(JOB, "/tmp/dowafu.db", "en", {
      spawn: ((...args: unknown[]) => {
        receivedArgs = args[1];
        receivedStdio = (args[2] as { stdio?: unknown }).stdio;
        return child;
      }) as typeof spawn,
      stderr: { write: (chunk: string | Uint8Array) => { written.push(Buffer.from(chunk).toString("utf8")); return true; } },
    });
    stderrEvents.emit("data", Buffer.from("request failed: stored-secret-token\\n"));
    events.emit("exit", 2, null);
    const result = await outcome;
    assert.deepEqual(receivedStdio, ["inherit", "inherit", "pipe"]);
    assert.deepEqual((receivedArgs as string[]).slice(-2), ["--lang", "zh"], "job language must override the daemon fallback");
    assert.equal(written.join(""), "request failed: stored-secret-token\\n");
    assert.match(result.error ?? "", /worker 以 exit code 2 結束/);
    assert.match(result.error ?? "", /request failed/);
    assert.doesNotMatch(result.error ?? "", /stored-secret-token/);
  } finally {
    registerSecrets([]);
  }
});

test("runCliJob：舊 job 沒有 lang 時沿用 daemon 起動時語言", async () => {
  const events = new EventEmitter();
  const child = Object.assign(events, { stderr: new EventEmitter() }) as unknown as ChildProcess;
  let receivedArgs: unknown;
  const outcome = runCliJob({ ...JOB, lang: null }, "/tmp/dowafu.db", "en", {
    spawn: ((...args: unknown[]) => {
      receivedArgs = args[1];
      return child;
    }) as typeof spawn,
    stderr: { write: () => true },
  });
  events.emit("exit", 0, null);
  assert.deepEqual(await outcome, {});
  assert.deepEqual((receivedArgs as string[]).slice(-2), ["--lang", "en"]);
});

test("worker failure：空 stderr 仍可讀，兩種語言不能固定回英文", () => {
  const en = workerFailureMessage("en", 4, null, "");
  const zh = workerFailureMessage("zh", 4, null, "");
  assert.match(en, /worker exited 4/);
  assert.match(zh, /exit code 4/);
  assert.notEqual(en, zh);
});

function stopDeps(states: ReturnType<StopDaemonDeps["liveness"]>[], command = "node /opt/dowafu/dist/cli.js serve"): StopDaemonDeps & { killed: number[] } {
  const killed: number[] = [];
  return {
    killed,
    liveness: () => states.shift() ?? { alive: false, reason: "pid_gone" },
    countRunningJobs: () => 0,
    processCommand: () => command,
    kill: (pid) => { killed.push(pid); },
    wait: async () => {},
  };
}

test("stopDaemon：有 running job 且未確認時 fail closed，絕不送訊號", async () => {
  const deps = stopDeps([{ alive: true, pid: 41 }]);
  deps.countRunningJobs = () => 2;
  const seen: number[] = [];
  const result = await stopDaemon("/tmp/dowafu.db", { confirmRunningJobs: async (count) => { seen.push(count); return false; }, deps });
  assert.deepEqual(result, { status: "cancelled", runningJobs: 2 });
  assert.deepEqual(seen, [2]);
  assert.deepEqual(deps.killed, []);
});

test("stopDaemon：沒有確認 callback 的非互動預設同樣拒絕 running job", async () => {
  const deps = stopDeps([{ alive: true, pid: 42 }]);
  deps.countRunningJobs = () => 1;
  const result = await stopDaemon("/tmp/dowafu.db", { deps });
  assert.deepEqual(result, { status: "cancelled", runningJobs: 1 });
  assert.deepEqual(deps.killed, []);
});

test("stopDaemon：不是 dowafu 的 pid 不送訊號；停止失敗與未運行各有不同結果", async () => {
  const wrong = stopDeps([{ alive: true, pid: 43 }], "node unrelated.js");
  assert.deepEqual(await stopDaemon("/tmp/dowafu.db", { force: true, deps: wrong }), { status: "pid_not_dowafu", pid: 43 });
  assert.deepEqual(wrong.killed, []);

  const failed = stopDeps([{ alive: true, pid: 44 }, { alive: true, pid: 44 }]);
  failed.kill = () => { throw new Error("EPERM"); };
  assert.deepEqual(await stopDaemon("/tmp/dowafu.db", { force: true, deps: failed }), { status: "signal_failed", pid: 44 });
  assert.deepEqual(await stopDaemon("/tmp/dowafu.db", { force: true, deps: stopDeps([{ alive: false, reason: "heartbeat_stale" }]) }), { status: "not_running", reason: "heartbeat_stale" });
});

test("stopDaemon：確認停止後會偵測 OS 重拉，且停止訊息兩語不同", async () => {
  const stopped = stopDeps([{ alive: true, pid: 45 }, { alive: false, reason: "pid_gone" }, { alive: false, reason: "pid_gone" }]);
  assert.deepEqual(await stopDaemon("/tmp/dowafu.db", { force: true, deps: stopped }), { status: "stopped", pid: 45 });
  assert.deepEqual(stopped.killed, [45]);

  const restarted = stopDeps([{ alive: true, pid: 46 }, { alive: false, reason: "pid_gone" }, { alive: true, pid: 47 }]);
  assert.deepEqual(await stopDaemon("/tmp/dowafu.db", { force: true, deps: restarted }), { status: "restarted", pid: 46 });
  assert.notEqual(m("en", "daemonStopRestarted", 46), m("zh", "daemonStopRestarted", 46));
});

test("stopDaemon：running job 警告說明 daemon 不會中斷 active spoke，且中英不同", () => {
  const en = m("en", "daemonStopRunningWarning", 2);
  const zh = m("zh", "daemonStopRunningWarning", 2);
  assert.match(en, /does not stop/i);
  assert.match(en, /continue to completion/i);
  assert.doesNotMatch(en, /will interrupt/i);
  assert.match(zh, /不會停止正在跑的 spoke/);
  assert.match(zh, /結果與 API 成本仍會被認列/);
  assert.notEqual(en, zh);
});
