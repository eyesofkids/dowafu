// B（gaps #6）：派工途中的進度。
//
// 在此之前，跑的過程中沒有任何可查的訊號：`results` 每支 spoke 只在**跑完的那一刻**寫一次
// （`cli.ts` 的 `spokes.map` 內，§13（一）：「每支 spoke 完成即落檔，不等 Promise.allSettled」），
// 所以多支 spoke 的工單至少看得到「又完成一支」，**單支 spoke 的工單則完全沒有訊號**
// ——而那是最常見的形態，最壞要安靜十分鐘。skill 因此只能寫「安靜不代表當掉」。
//
// 事件來源不是新的：`runner.ts` 的 `round` 事件本來就每輪都發，只是**第二個消費者被拔掉了**
// ——`RunLogWriter` 曾把同一串事件寫進 `run.jsonl`，票 B 退場之後 DB 這側沒人接。
// 這個模組就是把那個接頭接回來，接到 DB。
//
// **與 jobs.heartbeat_at 的分工**（兩個問題，兩個訊號，不要混）：
//   - 「worker 還活著嗎」→ `jobs.heartbeat_at`，running 期間每 2 秒更新（既有）
//   - 「有在往前走嗎」  → 這張表的列數／最大 round（新增）
// 兩者一起看才分得出「卡在 429 重試」（心跳新鮮、進度不動）與「行程死了」（心跳也停了）。
import type { DatabaseSync } from "node:sqlite";
import type { NormalizedUsage } from "./types.js";

export type SpokeProgress = {
  agent: string;
  rounds: number;
  lastRound: number;
  lastAt: string;
  tokensIn: number;
  tokensOut: number;
};

// **絕不讓進度寫入弄死一次已付費的派工。** 這張表是可丟棄的診斷資料，而呼叫端正在跑的是
// 花了錢的東西——任何 SQLite 例外都在這裡吞掉，不往上拋。同一個 (result_id, agent, round)
// 重寫直接覆蓋：進度不是已付費產出，沒有 `results` 那條「實質不同的重寫要炸出來」的顧慮
// （那條守的是 D1-hot3 的「落檔失敗不得銷毀已付費結果」，見 output.ts）。
export function recordRound(
  db: DatabaseSync,
  resultId: string,
  agent: string,
  round: number,
  usage: NormalizedUsage,
  hasToolCalls: boolean,
  now: () => string = () => new Date().toISOString(),
): void {
  try {
    db.prepare(
      `INSERT INTO progress (result_id, agent, round, at, tokens_in, tokens_out, has_tool_calls)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(result_id, agent, round) DO UPDATE SET
         at = excluded.at, tokens_in = excluded.tokens_in,
         tokens_out = excluded.tokens_out, has_tool_calls = excluded.has_tool_calls`,
    ).run(resultId, agent, round, now(), usage.inputTokens, usage.outputTokens, hasToolCalls ? 1 : 0);
  } catch {
    // 吞掉：見上方。進度查不到比派工中斷好。
  }
}

// 每支 spoke 一列摘要，依 agent 排序（不是插入序——不同機器上的列序不該讓輸出長得不一樣）。
export function readProgress(db: DatabaseSync, resultId: string): SpokeProgress[] {
  return (
    db
      .prepare(
        `SELECT agent,
                count(*)        AS rounds,
                max(round)      AS last_round,
                max(at)         AS last_at,
                sum(tokens_in)  AS tokens_in,
                sum(tokens_out) AS tokens_out
           FROM progress WHERE result_id = ?
          GROUP BY agent ORDER BY agent`,
      )
      .all(resultId) as Array<{
      agent: string;
      rounds: number;
      last_round: number;
      last_at: string;
      tokens_in: number;
      tokens_out: number;
    }>
  ).map((row) => ({
    agent: row.agent,
    rounds: Number(row.rounds),
    lastRound: Number(row.last_round),
    lastAt: row.last_at,
    tokensIn: Number(row.tokens_in),
    tokensOut: Number(row.tokens_out),
  }));
}
