import { test } from "node:test";
import assert from "node:assert/strict";
import { describeError, registerSecrets } from "./mask.js";

// issue_log_v2.5.md 待修 #10：describeError 對 errorBody 做 JSON.stringify，而 runSpoke
// 沒有包住這條路徑。序列化拋錯的下場不是「少一個欄位」，是**整支 spoke 落到 allSettled 的
// 防禦分支：status failed，且那次錯誤本身不會被記錄**——因為記錄它正是這個函式的工作。
// 遮蔽層不得成為新的失敗來源，故本檔測的是「拋不拋」而非訊息長相。
//
// mask.ts 先前完全沒有測試覆蓋，本輪連同 registerSecrets 的基本行為一併補上。

test("describeError：errorBody 含 BigInt（JSON.stringify 會拋 TypeError）→ 降級為固定字串，不往上拋", () => {
  const err = { status: 500, error: { retryAfterNanos: 1n } };
  const described = describeError(err);
  assert.equal(described.status, 500);
  assert.equal(described.errorBody?.message, "[unserializable error body]");
});

test("describeError：errorBody 有循環引用 → 同樣降級，不往上拋", () => {
  const body: Record<string, unknown> = { code: "loop" };
  body.self = body;
  const described = describeError({ status: 502, error: body });
  assert.equal(described.status, 502);
  assert.equal(described.errorBody?.message, "[unserializable error body]");
});

test("describeError：可序列化的 errorBody 維持原行為，且經遮蔽", () => {
  registerSecrets(["sk-describeerror-should-be-masked"]);
  const described = describeError({
    status: 401,
    error: { message: "invalid key sk-describeerror-should-be-masked" },
  });
  assert.equal(described.status, 401);
  assert.ok(described.errorBody, "可序列化時應有 errorBody");
  assert.equal(
    described.errorBody?.message.includes("sk-describeerror-should-be-masked"),
    false,
    "errorBody 不得含未遮蔽的秘密",
  );
  assert.ok(described.errorBody?.message.includes("invalid key"), "遮蔽不應吃掉其餘內容");
});

test("describeError：429 判定不受序列化失敗影響（is429 來自 status，不是 body）", () => {
  const described = describeError({ status: 429, error: { nanos: 2n } });
  assert.equal(described.is429, true);
  assert.equal(described.errorBody?.message, "[unserializable error body]");
});
