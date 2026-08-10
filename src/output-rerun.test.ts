import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureOutDir, RunLogWriter } from "./output.js";

// plan_dispatch_v1.8.md §13：「同一工單重跑會覆蓋同名輸出目錄——刻意行為」。
// §12 的「append 寫入」講的是**單次執行內**的中斷安全（SIGKILL 時最多損失最後一行），
// 不是跨次累積。實作只做了後者：summary.md／<agent>.md／raw/*.json 走 writeFile 自然
// 覆蓋，唯獨 run.jsonl 走 appendFile 且 ensureOutDir 不清空，於是重跑會把上一次的事件
// 留著。
//
// 實測踩點（issue_log_v2.0.md 2026-08-07）：同工單重跑後，run.jsonl 數出 9／22 次
// 工具呼叫，summary.md 寫 7／20，spoke_end 事件共 4 個（每支 2 個）——多出來的正是上一次
// 的事件。而 toolCalls[] 是偵測「零讀取」的唯一依據，v2.1 又剛把「重跑」訂為零讀取的標準
// 處置，這條路徑因此從罕見變成常見。

test("ensureOutDir：重跑時清空 run.jsonl，不讓上一次的事件累積（§13 覆蓋語意）", async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "dispatch-rerun-"));
  try {
    // 模擬前一次派工留下的 run.jsonl
    const logPath = path.join(outDir, "run.jsonl");
    writeFileSync(logPath, '{"type":"spoke_end","agent":"舊跑"}\n{"type":"tool_call","agent":"舊跑"}\n');

    await ensureOutDir(outDir);

    const after = readFileSync(logPath, "utf8");
    assert.equal(after, "", `重跑後 run.jsonl 應為空，實際殘留：\n${after}`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("ensureOutDir：清空後 RunLogWriter 仍可正常追加，且只含本次事件", async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "dispatch-rerun-append-"));
  try {
    const logPath = path.join(outDir, "run.jsonl");
    writeFileSync(logPath, '{"type":"spoke_end","agent":"舊跑"}\n');

    await ensureOutDir(outDir);
    const writer = new RunLogWriter(logPath);
    writer.append({ type: "spoke_start", agent: "本次" });
    writer.append({ type: "spoke_end", agent: "本次" });
    await writer.flush();

    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2, "應只有本次的兩筆");
    assert.ok(
      lines.every((e) => e.agent === "本次"),
      `不得殘留舊跑事件，實際：${JSON.stringify(lines)}`,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("ensureOutDir：目錄不存在時照常建立（含 raw/），且 run.jsonl 為空檔而非缺檔", async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "dispatch-rerun-fresh-"));
  const outDir = path.join(parent, "never-existed");
  try {
    await ensureOutDir(outDir);
    assert.ok(existsSync(path.join(outDir, "raw")), "raw/ 須被建立");
    assert.equal(readFileSync(path.join(outDir, "run.jsonl"), "utf8"), "");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
