import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDb } from "./db.js";
import { readProgress, recordRound } from "./progress.js";
import type { NormalizedUsage } from "./types.js";

function usage(inputTokens: number, outputTokens: number): NormalizedUsage {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, available: true };
}

function withDb(run: (db: ReturnType<typeof openDb>) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "progress-"));
  try {
    const db = openDb(path.join(root, "dowafu.db"), "en");
    run(db);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// **每輪一列，不是更新同一列。** 「哪一輪慢」是 RunLogWriter 退場時明文記為降級的四項之一，
// 逐列才留得住輪級時間戳；更新同一列只留得下最後一輪。
test("progress：每輪 append 一列，摘要給出輪數、最大 round 與累計 token", () => {
  withDb((db) => {
    recordRound(db, "job-1", "reviewer", 1, usage(100, 20), true, () => "2026-09-07T00:00:01.000Z");
    recordRound(db, "job-1", "reviewer", 2, usage(150, 30), false, () => "2026-09-07T00:00:09.000Z");

    const rows = db.prepare("SELECT round, at FROM progress WHERE result_id = ? AND agent = ? ORDER BY round").all("job-1", "reviewer") as Array<{ round: number; at: string }>;
    assert.equal(rows.length, 2, "兩輪應該留下兩列，不是覆蓋成一列");
    assert.deepEqual(rows.map((r) => r.at), ["2026-09-07T00:00:01.000Z", "2026-09-07T00:00:09.000Z"]);

    const [summary] = readProgress(db, "job-1");
    assert.equal(summary.rounds, 2);
    assert.equal(summary.lastRound, 2);
    assert.equal(summary.tokensIn, 250);
    assert.equal(summary.tokensOut, 50);
    assert.equal(summary.lastAt, "2026-09-07T00:00:09.000Z");
  });
});

test("progress：多支 spoke 各自獨立，依 agent 排序（不吃列序）", () => {
  withDb((db) => {
    recordRound(db, "job-1", "zeta", 1, usage(1, 1), false);
    recordRound(db, "job-1", "alpha", 1, usage(2, 2), false);
    recordRound(db, "job-2", "alpha", 1, usage(9, 9), false);
    assert.deepEqual(readProgress(db, "job-1").map((p) => p.agent), ["alpha", "zeta"]);
    assert.equal(readProgress(db, "job-2").length, 1);
  });
});

// **進度查不到，也不該弄死一次已付費的派工。** 呼叫端正在跑的是花了錢的東西，而這張表
// 是可丟棄的診斷資料——任何 SQLite 例外都要在 recordRound 裡吞掉，不往上拋。
test("progress：寫入失敗不往上拋（表被刪掉也不能弄死派工）", () => {
  withDb((db) => {
    db.exec("DROP TABLE progress");
    assert.doesNotThrow(() => recordRound(db, "job-1", "reviewer", 1, usage(1, 1), false));
  });
});

// 同一輪重寫直接覆蓋，不像 results 那樣把「實質不同的重寫」當成要炸出來的錯——
// 那條守的是已付費產出（D1-hot3），進度沒有那個顧慮。
test("progress：同一輪重寫是覆蓋，不拋錯", () => {
  withDb((db) => {
    recordRound(db, "job-1", "reviewer", 1, usage(100, 20), false, () => "2026-09-07T00:00:01.000Z");
    assert.doesNotThrow(() => recordRound(db, "job-1", "reviewer", 1, usage(999, 888), true, () => "2026-09-07T00:00:05.000Z"));
    const [summary] = readProgress(db, "job-1");
    assert.equal(summary.rounds, 1);
    assert.equal(summary.tokensIn, 999);
    assert.equal(summary.lastAt, "2026-09-07T00:00:05.000Z");
  });
});
