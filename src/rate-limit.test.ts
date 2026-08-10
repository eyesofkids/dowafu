import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfter } from "./rate-limit.js";

test("第 1 段：Retry-After 為純數字 header → 秒數，來源 header", () => {
  const r = parseRetryAfter("2.595", undefined, 0);
  assert.deepEqual(r, { seconds: 2.595, source: "header" });
});

test("第 1 段：Retry-After 為 HTTP-date → 與現在時間之差", () => {
  const now = Date.parse("2026-08-05T12:00:00Z");
  const headerDate = new Date(now + 5000).toUTCString();
  const r = parseRetryAfter(headerDate, undefined, 0, now);
  assert.equal(r.source, "header");
  assert.ok(Math.abs(r.seconds - 5) < 0.01);
});

test("第 1 段解析失敗（非數字非合法日期）落入第 2 段", () => {
  const r = parseRetryAfter("not-a-valid-header", "please retry in 3s", 0);
  assert.deepEqual(r, { seconds: 3, source: "message" });
});

test("第 2 段：錯誤訊息 regex 涵蓋 2.595s / 30 seconds 等變體", () => {
  assert.deepEqual(parseRetryAfter(undefined, "try again in 2.595s", 0), { seconds: 2.595, source: "message" });
  assert.deepEqual(parseRetryAfter(undefined, "wait 30 seconds please", 0), { seconds: 30, source: "message" });
  assert.deepEqual(parseRetryAfter(undefined, "retry after 4 sec", 0), { seconds: 4, source: "message" });
});

test("第 3 段：header 與 message 都沒有 → 指數退避，依 attemptIndex 遞增", () => {
  assert.deepEqual(parseRetryAfter(undefined, undefined, 0), { seconds: 2, source: "backoff" });
  assert.deepEqual(parseRetryAfter(undefined, undefined, 1), { seconds: 4, source: "backoff" });
  assert.deepEqual(parseRetryAfter(undefined, undefined, 4), { seconds: 32, source: "backoff" });
});

test("第 3 段：attemptIndex 超過表長時鎖在最大值，不越界", () => {
  assert.deepEqual(parseRetryAfter(undefined, undefined, 99), { seconds: 32, source: "backoff" });
});

test("非英文訊息對第 2 段必然失效，落到第 3 段兜底（刻意取捨，見 §13）", () => {
  const r = parseRetryAfter(undefined, "請於 3 秒後重試", 0);
  assert.equal(r.source, "backoff");
});
