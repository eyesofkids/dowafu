import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyError } from "./error-classify.js";

// plan_dispatch_v1.8.md §13：暫時性＝5xx／408／無 HTTP 回應；確定性＝其他 4xx。

test("classifyError：5xx 為暫時性", () => {
  assert.equal(classifyError(500), "transient");
  assert.equal(classifyError(502), "transient");
  assert.equal(classifyError(599), "transient");
});

test("classifyError：408 為暫時性", () => {
  assert.equal(classifyError(408), "transient");
});

test("classifyError：無 HTTP 回應（status undefined，網路層錯誤）為暫時性", () => {
  assert.equal(classifyError(undefined), "transient");
});

// v0.3.0 對測實地踩到的迴歸：`adapters/responses.ts` 把連線錯誤正規化成 `status ?? 0`，
// 而本函式原本只認 undefined，於是 0 落進「其他 4xx」的 permanent 分支——**連線失敗一次
// 都不重試**。這一條測的是那個哨兵值，刪掉它等於把那個 bug 放回來。
test("classifyError：status 0（adapter 對『無 HTTP 回應』的哨兵值）為暫時性", () => {
  assert.equal(classifyError(0), "transient");
});

test("classifyError：其他 4xx 為確定性，不重試", () => {
  assert.equal(classifyError(400), "permanent");
  assert.equal(classifyError(401), "permanent");
  assert.equal(classifyError(403), "permanent");
  assert.equal(classifyError(404), "permanent");
});
