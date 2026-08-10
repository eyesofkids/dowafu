import { test } from "node:test";
import assert from "node:assert/strict";
import { auditToolCalls } from "./tool-call-audit.js";
import type { ToolCallLog } from "./types.js";

// plan_dispatch_v2.0.md §15（一）：本項屬「規格已定但未實作」——v1.8 §15 的稽核表列六項，
// output.ts 只渲染五項，缺的正是這欄。素材取自 issue_log_v2.0.md 2026-08-07 的真實案例：
// igopms／non-internal-api-auth 兩支 spoke 只讀了 _shared.md 與自己的工單檔，35 個允許
// 讀取的原始碼檔一個都沒開，而舊版稽核輸出全部 pass。

function log(overrides: Partial<ToolCallLog> = {}): ToolCallLog {
  return { path: "a.ts", allowed: true, startedAt: 0, durationMs: 1, ...overrides };
}

test("auditToolCalls：全部 tool 呼叫都是工單檔（_shared.md／<agent>.md）且允許清單非空 → zeroSourceRead", () => {
  const calls = [log({ path: "/tmp/ticket/_shared.md" }), log({ path: "/tmp/ticket/hole-finder-safety.md" })];
  const result = auditToolCalls("hole-finder-safety", calls, 35);
  assert.equal(result.total, 2);
  assert.equal(result.allowed, 2);
  assert.equal(result.rejected, 0);
  assert.equal(result.zeroSourceRead, true);
});

test("auditToolCalls：真實讀了允許清單內的原始碼檔 → zeroSourceRead 為 false（即使也讀了工單檔）", () => {
  const calls = [
    log({ path: "/tmp/ticket/_shared.md" }),
    log({ path: "/tmp/ticket/hole-finder-safety.md" }),
    log({ path: "lib/hash.ts" }),
  ];
  const result = auditToolCalls("hole-finder-safety", calls, 35);
  assert.equal(result.zeroSourceRead, false);
});

test("auditToolCalls：允許清單為空時，即使全讀工單檔也不標示（沒有清單可讀，非「有清單不讀」）", () => {
  const calls = [log({ path: "/tmp/ticket/_shared.md" }), log({ path: "/tmp/ticket/hole-finder-safety.md" })];
  const result = auditToolCalls("hole-finder-safety", calls, 0);
  assert.equal(result.zeroSourceRead, false);
});

test("auditToolCalls：完全沒有 tool 呼叫時不標示零讀取（那是另一種訊號：連工單都沒讀）", () => {
  const result = auditToolCalls("hole-finder-safety", [], 35);
  assert.equal(result.total, 0);
  assert.equal(result.zeroSourceRead, false);
});

test("auditToolCalls：被拒的呼叫仍計入 total／rejected，不影響 allowed 計數", () => {
  const calls = [
    log({ path: "/tmp/ticket/_shared.md" }),
    log({ path: "src/secret.ts", allowed: false, reason: "not_in_allowlist" }),
  ];
  const result = auditToolCalls("hole-finder-safety", calls, 5);
  assert.equal(result.total, 2);
  assert.equal(result.allowed, 1);
  assert.equal(result.rejected, 1);
  // 嘗試讀了非工單檔（即使被拒），不算「全部落在工單目錄內」
  assert.equal(result.zeroSourceRead, false);
});

test("auditToolCalls：路徑帶目錄前綴時仍以 basename 判定是否為工單檔（相對／絕對路徑皆同）", () => {
  const calls = [
    log({ path: "tmp/dispatch/x/_shared.md" }),
    log({ path: "/Volumes/repo/tmp/dispatch/x/hole-finder-feasibility.md" }),
  ];
  const result = auditToolCalls("hole-finder-feasibility", calls, 10);
  assert.equal(result.zeroSourceRead, true);
});
