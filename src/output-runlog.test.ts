import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunLogWriter } from "./output.js";
import { registerSecrets } from "./mask.js";

// plan_dispatch_v2.4.md §12：run.jsonl 每個事件加 ts（事件發生時刻），且單次 appendFile
// 失敗不得毒化整條 queue。

function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "runlog-test-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("RunLogWriter.append：每行含合法 ISO 8601 格式的 ts 欄位", async () => {
  await withTmpDir(async (dir) => {
    const logPath = path.join(dir, "run.jsonl");
    writeFileSync(logPath, "", "utf8");
    const writer = new RunLogWriter(logPath, "zh");
    writer.append({ type: "spoke_start", agent: "a" });
    await writer.flush();

    const line = JSON.parse(readFileSync(logPath, "utf8").trim());
    assert.equal(typeof line.ts, "string", "應含 ts 欄位");
    assert.equal(new Date(line.ts).toISOString(), line.ts, "ts 須為合法 ISO 8601（毫秒精度）字串");
  });
});

test("RunLogWriter.append：ts 於 maskDeep 之後加入，不受遮蔽規則誤傷", async () => {
  await withTmpDir(async (dir) => {
    // "20" 幾乎必定出現在任何西元年份組成的 ISO 時間字串裡（例如 2026-08-07T...）；
    // 若 ts 被搶先送進 maskDeep 遮蔽，這裡就會被打成 ***REDACTED***，斷言即失敗。
    registerSecrets(["20"]);
    try {
      const logPath = path.join(dir, "run.jsonl");
      writeFileSync(logPath, "", "utf8");
      const writer = new RunLogWriter(logPath, "zh");
      writer.append({ type: "spoke_start", agent: "agent-20-x" });
      await writer.flush();

      const line = JSON.parse(readFileSync(logPath, "utf8").trim());
      assert.equal(new Date(line.ts).toISOString(), line.ts, "ts 不得被遮蔽邏輯改寫");
      assert.match(line.agent, /\*\*\*REDACTED\*\*\*/, "對照組：一般欄位仍應正常被遮蔽，證明遮蔽機制確實有跑");
    } finally {
      registerSecrets([]);
    }
  });
});

test("RunLogWriter.append：queue 中一次 appendFile 失敗後，後續 append 仍寫得進去、flush() 不 rejected（§12 規格二）", async () => {
  await withTmpDir(async (dir) => {
    const logPath = path.join(dir, "run.jsonl");
    writeFileSync(logPath, "", "utf8");
    const writer = new RunLogWriter(logPath, "zh");

    chmodSync(logPath, 0o444); // 唯讀，讓下一次 appendFile 因 EACCES 失敗
    writer.append({ type: "spoke_start", agent: "會失敗" });
    await assert.doesNotReject(() => writer.flush(), "單次寫入失敗不得讓 flush() rejected");

    chmodSync(logPath, 0o644); // 恢復可寫
    writer.append({ type: "spoke_end", agent: "應該寫得進去" });
    await assert.doesNotReject(() => writer.flush(), "後續 append 不受先前失敗影響");

    const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(
      lines.some((e) => e.agent === "應該寫得進去"),
      `失敗後的 append 應該仍寫得進去，實際內容：${JSON.stringify(lines)}`,
    );
  });
});
