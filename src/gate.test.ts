import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkGateOne, estimateAllowlistTokens, estimateSequentialRead, estimateTokens, type SpokeEstimate } from "./gate.js";
import { DispatchError } from "./types.js";

// gate.ts 先前無測試覆蓋。本輪新增 estimateAllowlistTokens（plan_dispatch_v2.0.md §14），
// 順帶補上既有 estimateTokens／checkGateOne 的基本案例。

test("estimateTokens：chars / charsPerToken 無條件進位", () => {
  assert.equal(estimateTokens("abcde", 2), 3); // 5/2 = 2.5 → 3
  assert.equal(estimateTokens("", 1), 0);
});

test("checkGateOne：合計超過 --max-tokens 時拋 DispatchError（exit 3）", () => {
  const estimates: SpokeEstimate[] = [
    { agent: "a", estimatedTokens: 150_000 },
    { agent: "b", estimatedTokens: 60_000 },
  ];
  assert.throws(
    () => checkGateOne(estimates, 200_000),
    (err: unknown) => err instanceof DispatchError && err.exitCode === 3,
  );
});

test("checkGateOne：未超過時回傳合計，不拋錯", () => {
  const estimates: SpokeEstimate[] = [{ agent: "a", estimatedTokens: 100 }];
  assert.equal(checkGateOne(estimates, 200_000), 100);
});

test("estimateAllowlistTokens：加總所有檔案的 chars 後套用同一公式，不是逐檔各自無條件進位", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-test-"));
  try {
    const f1 = path.join(dir, "a.ts");
    const f2 = path.join(dir, "b.ts");
    writeFileSync(f1, "a".repeat(3), "utf8"); // 3 chars
    writeFileSync(f2, "b".repeat(4), "utf8"); // 4 chars
    // 合計 7 chars / charsPerToken 2 = 3.5 → 4（先加總再進位，非 ceil(3/2)+ceil(4/2)=2+2=4——
    // 這個案例湊巧同值，換一組數字驗證兩種算法會分岔）
    assert.equal(estimateAllowlistTokens([f1, f2], 2), 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("estimateAllowlistTokens：先加總再除，與逐檔進位後加總在特定數字下確實不同（驗證加總順序）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gate-test-"));
  try {
    const f1 = path.join(dir, "a.ts");
    const f2 = path.join(dir, "b.ts");
    writeFileSync(f1, "a".repeat(1), "utf8"); // 1 char
    writeFileSync(f2, "b".repeat(1), "utf8"); // 1 char
    // 逐檔進位後加總：ceil(1/4)+ceil(1/4) = 1+1 = 2
    // 先加總再進位：ceil(2/4) = 1 ← 本函式採用這個算法
    assert.equal(estimateAllowlistTokens([f1, f2], 4), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("estimateAllowlistTokens：空清單回傳 0", () => {
  assert.equal(estimateAllowlistTokens([], 1.0), 0);
});

// issue_log_v2.1.md（第 8、9 次派工）：spoke 嚴格照清單順序讀檔，逐個叫時每輪重送全部歷史，
// 故第 i 個檔會被計費 (n+1-i) 次。權重錯了會讓 dry-run 給出誤導性的排序建議，故用手算得出
// 的確定數字鎖住，不用「大概比較小」這種弱斷言。
test("estimateSequentialRead：權重為 (n+1-i)，大檔排前面時放大量最大", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "seq-"));
  try {
    // 三個檔：100、10、1 字元。charsPerToken=1 使 token 數 == 字元數，方便手算。
    const big = path.join(dir, "big.txt");
    const mid = path.join(dir, "mid.txt");
    const small = path.join(dir, "small.txt");
    writeFileSync(big, "x".repeat(100), "utf8");
    writeFileSync(mid, "x".repeat(10), "utf8");
    writeFileSync(small, "x", "utf8");

    // 大→小：100*3 + 10*2 + 1*1 = 321
    const worst = estimateSequentialRead([big, mid, small], 1);
    assert.equal(worst.asListed, 321, "大檔排最前面時放大量最大");
    // 小→大：1*3 + 10*2 + 100*1 = 123
    assert.equal(worst.sorted, 123, "sorted 一律為依大小遞增的結果");

    // 已是最佳順序時，asListed 應等於 sorted
    const best = estimateSequentialRead([small, mid, big], 1);
    assert.equal(best.asListed, 123);
    assert.equal(best.sorted, 123);

    // sorted 永遠不大於 asListed——這是「大檔排最後」建議的成立前提
    assert.ok(worst.sorted <= worst.asListed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("estimateSequentialRead：空清單回 0，不除以零也不拋錯", () => {
  const e = estimateSequentialRead([], 1);
  assert.equal(e.asListed, 0);
  assert.equal(e.sorted, 0);
});
