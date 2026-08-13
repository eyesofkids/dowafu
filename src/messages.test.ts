import { test } from "node:test";
import assert from "node:assert/strict";
import { m } from "./messages.js";

// arity／key 是否齊全由 tsc --noEmit 擋（見 pnpm run typecheck）；tsx --test 不做型別檢查
// （plan_i18n_v1.2.md §5.4），這裡只驗證執行期輸出正確，不是型別安全網。

// T3〈開工第一件事〉（結轉自 T2）：T2 用 @ts-expect-error 手動驗證過「key 打錯／arity
// 少一個參數／參數型別錯」真的會被 tsc 擋下，但 probe 沒有留在 commit 裡。往後 T3–T5
// 要往 MessageArgs 填進上百個 key，過程中只要有人為了方便把型別放寬（加 index signature、
// 改成 Record<string, ...>、某處補個 any），這個守衛就會靜默失效、四綠照樣全過——三行
// 買一個回歸保護。故意寫錯的呼叫包在一個「宣告但不呼叫」的函式裡：@ts-expect-error 只讓
// tsc --noEmit 看見這幾行；包成不執行的函式體，避免 tsx --test 真的跑到這幾個會拋錯的呼叫。
// `void` 那行只是讓這個函式被視為「有用到」，不觸發 no-unused-vars，不會讓函式被呼叫。
function _typeGuardProbes(): void {
  // @ts-expect-error key 不存在——MessageArgs 沒有這個 key，`m()` 的第二個參數該紅
  m("zh", "notARealMessageKey");
  // @ts-expect-error 少一個必要參數——unknownOption 需要 2 個 string 參數，這裡只給 1 個
  m("zh", "unknownOption", "--foo");
  // @ts-expect-error 參數型別錯——unknownOption 的兩個參數都該是 string，這裡塞數字
  m("zh", "unknownOption", 123, 456);
}
void _typeGuardProbes;

test("m()：兩種語言各自產出對應文字，參數正確代入", () => {
  assert.equal(m("zh", "unknownOption", "--foo", "help text"), "未知選項：--foo\n\nhelp text");
  assert.equal(m("en", "unknownOption", "--foo", "help text"), "Unknown option: --foo\n\nhelp text");
});

test("m()：0 參數 key", () => {
  assert.equal(m("zh", "dryRunNotice"), "--dry-run：僅解析／驗證／估算／印報表，未呼叫任何 API。");
  assert.equal(
    m("en", "dryRunNotice"),
    "--dry-run: parsed, validated, estimated, and reported only; no API calls were made.",
  );
});

test("m()：1 參數 key", () => {
  assert.equal(m("zh", "missingProviders", "/x/providers.json"), "找不到 providers.json：/x/providers.json");
  assert.equal(m("en", "missingProviders", "/x/providers.json"), "providers.json not found: /x/providers.json");
});
