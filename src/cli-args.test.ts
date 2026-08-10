import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, HELP_TEXT } from "./cli-args.js";
import { DispatchError } from "./types.js";

// plan_dispatch_v1.10.md §9／§20：--repo-root／--providers／--json／--help／--version，
// 以及兩處收緊（多餘 positional 即中止；無參數印完整用法）。

test("parseArgs：基本情況——只有 ticketDir，其餘走預設值", () => {
  const parsed = parseArgs(["tmp/dispatch/t1"]);
  assert.equal(parsed.mode, "run");
  if (parsed.mode !== "run") throw new Error("unreachable");
  assert.equal(parsed.ticketDir, "tmp/dispatch/t1");
  assert.equal(parsed.options.json, false);
  assert.equal(parsed.options.repoRoot, undefined);
  assert.equal(parsed.options.providersPath, undefined);
  assert.equal(parsed.options.retries, 2); // v1.7 裁示的預設值，非本輪變更但一併確認未被本輪改動打壞
});

test("parseArgs：--repo-root 與 --providers 正確寫入 options", () => {
  const parsed = parseArgs(["t1", "--repo-root", "/some/project", "--providers", "/custom/providers.json"]);
  assert.equal(parsed.mode, "run");
  if (parsed.mode !== "run") throw new Error("unreachable");
  assert.equal(parsed.options.repoRoot, "/some/project");
  assert.equal(parsed.options.providersPath, "/custom/providers.json");
});

test("parseArgs：--json 旗標", () => {
  const parsed = parseArgs(["t1", "--json"]);
  assert.equal(parsed.mode, "run");
  if (parsed.mode !== "run") throw new Error("unreachable");
  assert.equal(parsed.options.json, true);
});

test("parseArgs：--help 不需要 ticketDir，回傳 mode:help", () => {
  assert.deepEqual(parseArgs(["--help"]), { mode: "help" });
  assert.deepEqual(parseArgs(["-h"]), { mode: "help" });
});

test("parseArgs：--help 出現在任何位置皆生效，優先於其他解析（不因後面有非法旗標而先報錯）", () => {
  assert.deepEqual(parseArgs(["t1", "--totally-unknown-flag", "--help"]), { mode: "help" });
});

test("parseArgs：--version／-V 不需要 ticketDir，回傳 mode:version", () => {
  assert.deepEqual(parseArgs(["--version"]), { mode: "version" });
  assert.deepEqual(parseArgs(["-V"]), { mode: "version" });
});

test("parseArgs：無任何引數 → 拋 DispatchError，訊息為完整用法，exit 2", () => {
  assert.throws(() => parseArgs([]), (err: unknown) => {
    assert.ok(err instanceof DispatchError);
    assert.equal(err.exitCode, 2);
    assert.equal(err.message, HELP_TEXT);
    return true;
  });
});

test("parseArgs：第二個 positional 即中止（v1.10 §9，原本靜默忽略違反 fail closed）", () => {
  assert.throws(() => parseArgs(["ticket-a", "ticket-b"]), (err: unknown) => {
    assert.ok(err instanceof DispatchError);
    assert.equal(err.exitCode, 2);
    assert.match(err.message, /多餘的引數：ticket-b/);
    return true;
  });
});

test("parseArgs：未知旗標仍中止（既有行為，確認拆分後未壞）", () => {
  assert.throws(() => parseArgs(["t1", "--not-a-real-flag", "x"]), DispatchError);
});

test("parseArgs：數字旗標收到非數字 → 中止", () => {
  assert.throws(() => parseArgs(["t1", "--concurrency", "abc"]), DispatchError);
});
