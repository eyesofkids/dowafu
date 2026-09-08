import fs from "node:fs";
import { m } from "./messages.js";
import type { Lang } from "./types.js";

export const DAEMON_STALE_MS = 15_000;

export type DaemonLiveness =
  | { alive: true; pid: number }
  | { alive: false; reason: "heartbeat_missing" | "heartbeat_stale" | "pid_gone" };

type Heartbeat = { pid: number; at: number };

export type LivenessDeps = {
  readFile: (path: string, encoding: "utf8") => string;
  writeFile: (path: string, data: string) => void;
  kill: (pid: number, signal: 0) => void;
  now: () => number;
};

const DEFAULT_DEPS: LivenessDeps = {
  readFile: fs.readFileSync,
  writeFile: fs.writeFileSync,
  kill: process.kill.bind(process),
  now: Date.now,
};

export function daemonStatePath(dbPath: string): string {
  return `${dbPath}.daemon`;
}

export function writeHeartbeat(statePath: string, pid: number = process.pid, deps: LivenessDeps = DEFAULT_DEPS): void {
  deps.writeFile(statePath, JSON.stringify({ pid, at: deps.now() }));
}

export function daemonAlive(statePath: string, deps: LivenessDeps = DEFAULT_DEPS): DaemonLiveness {
  let heartbeat: Heartbeat;
  try {
    heartbeat = JSON.parse(deps.readFile(statePath, "utf8")) as Heartbeat;
  } catch {
    return { alive: false, reason: "heartbeat_missing" };
  }
  if (!Number.isInteger(heartbeat.pid) || !Number.isFinite(heartbeat.at)) return { alive: false, reason: "heartbeat_missing" };
  if (deps.now() - heartbeat.at > DAEMON_STALE_MS) return { alive: false, reason: "heartbeat_stale" };
  try {
    deps.kill(heartbeat.pid, 0);
  } catch {
    return { alive: false, reason: "pid_gone" };
  }
  return { alive: true, pid: heartbeat.pid };
}

// submit/status callers use this rather than treating an offline queue as success.
export function daemonWarning(state: DaemonLiveness, lang: Lang): string | null {
  return state.alive ? null : m(lang, "daemonOfflineWarning", state.reason);
}
