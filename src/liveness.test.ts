import assert from "node:assert/strict";
import { test } from "node:test";
import { DAEMON_STALE_MS, daemonAlive, daemonStatePath, daemonWarning, writeHeartbeat, type LivenessDeps } from "./liveness.js";

function deps(file: string | null, alive: boolean, now: number): LivenessDeps {
  return {
    readFile: () => {
      if (file === null) throw new Error("missing");
      return file;
    },
    writeFile: () => {},
    kill: () => {
      if (!alive) throw new Error("gone");
    },
    now: () => now,
  };
}

test("liveness：state 檔跟 DB 綁定，缺檔、過期、死 pid 都不是 alive", () => {
  assert.equal(daemonStatePath("/tmp/dowafu.db"), "/tmp/dowafu.db.daemon");
  assert.deepEqual(daemonAlive("x", deps(null, true, 100)), { alive: false, reason: "heartbeat_missing" });
  assert.deepEqual(daemonAlive("x", deps(JSON.stringify({ pid: 7, at: 0 }), true, DAEMON_STALE_MS + 1)), { alive: false, reason: "heartbeat_stale" });
  assert.deepEqual(daemonAlive("x", deps(JSON.stringify({ pid: 7, at: 100 }), false, 100)), { alive: false, reason: "pid_gone" });
});

test("liveness：新鮮心跳且 pid 存在才是 alive，beat 寫 pid 與時間", () => {
  assert.deepEqual(daemonAlive("x", deps(JSON.stringify({ pid: 7, at: 100 }), true, 100)), { alive: true, pid: 7 });
  let written = "";
  writeHeartbeat("x", 42, { ...deps(null, true, 123), writeFile: (_path, data) => (written = data) });
  assert.deepEqual(JSON.parse(written), { pid: 42, at: 123 });
});

test("liveness：submit 與狀態查詢可共用離線警告，存活時不誤報", () => {
  assert.match(daemonWarning({ alive: false, reason: "heartbeat_missing" }, "en") ?? "", /queued but will not execute/);
  assert.equal(daemonWarning({ alive: true, pid: 7 }, "en"), null);
});
