import { test } from "node:test";
import assert from "node:assert/strict";
import { m } from "./messages.js";

// impl_tickets_i18n_stage1.md T3b：cli.ts 的 outDirWritten／outDirNotWritable／
// outDirFallbackStderr／confirmPrompt／cancelledInteractive／cancelledNonInteractive 六則，
// 搬遷前測試命中 0（見 T3b〈缺口〉表）。
//
// 這六則在 cli.ts 裡是直接內嵌呼叫 m(lang, key, ...)（main() 內，見 cli.ts），沒有像
// formatEvent／buildStdoutSummary 那樣的獨立包裝函式可以匯入測試——main() 本身因為檔尾
// `main().catch()` 的無條件呼叫，import cli.ts 會直接跑掉整支程式（見 cli-args.ts 檔頭
// 說明），不安全，也不是這幾則訊息值得為此改動 cli.ts 結構的理由。因此比照 messages.test.ts
// 的作法，直接呼叫 m() 驗證這六個 key 「在該語言下的完整格式」（標籤、標點、單位）；
// 這幾則都只有 0～1 個參數，沒有相鄰同型參數可對調，但仍手寫字面期望值，不透過 m() 自身
// 重建期望值，維持與 formatEvent／buildStdoutSummary 兩則同一套「格式斷言不自我reconstruct」
// 的規矩（v1.2 §5.5）。

test("outDirNotWritable（zh／en）", () => {
  assert.equal(m("zh", "outDirNotWritable", "/tmp/out"), "落檔目錄不可寫：/tmp/out");
  assert.equal(m("en", "outDirNotWritable", "/tmp/out"), "Output directory is not writable: /tmp/out");
});

test("outDirWritten（zh／en）", () => {
  assert.equal(m("zh", "outDirWritten", "tmp/spoke/t1"), "落檔完成：tmp/spoke/t1/");
  assert.equal(m("en", "outDirWritten", "tmp/spoke/t1"), "Files written to: tmp/spoke/t1/");
});

test("outDirFallbackStderr（zh／en）", () => {
  assert.equal(m("zh", "outDirFallbackStderr"), "落檔目錄不可寫，完整報告已改印於 stderr：");
  assert.equal(
    m("en", "outDirFallbackStderr"),
    "Output directory is not writable; the full report was printed to stderr instead:",
  );
});

test("confirmPrompt（zh／en）", () => {
  assert.equal(m("zh", "confirmPrompt"), "繼續？[y/N] ");
  assert.equal(m("en", "confirmPrompt"), "Continue? [y/N] ");
});

test("cancelledInteractive（zh／en）", () => {
  assert.equal(m("zh", "cancelledInteractive"), "已取消，未呼叫任何 API。");
  assert.equal(m("en", "cancelledInteractive"), "Cancelled; no API calls were made.");
});

test("cancelledNonInteractive（zh／en）", () => {
  assert.equal(
    m("zh", "cancelledNonInteractive"),
    "非互動環境（stdin 不是 TTY）無人可確認，已取消，未呼叫任何 API。要在此環境派工請明確加上 --yes。",
  );
  assert.equal(
    m("en", "cancelledNonInteractive"),
    "Non-interactive environment (stdin is not a TTY); nobody could confirm. Cancelled; no API calls were made. To dispatch in this environment, pass --yes explicitly.",
  );
});
