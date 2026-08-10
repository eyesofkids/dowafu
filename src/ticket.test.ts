import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDispatchTable, parseSharedDoc, parseAgentTicket } from "./ticket.js";
import { DispatchError } from "./types.js";

test("parseDispatchTable：正常表格解析出 agent/provider/model/effort", () => {
  const md = `<!-- format: v1 -->
# dispatch ticket-001

| agent | provider | model | effort |
| --- | --- | --- | --- |
| hole-finder-safety | openai | gpt-5.6-luna | high |
| hole-finder-cost | deepseek | deepseek-v4-flash | |
`;
  const rows = parseDispatchTable(md);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    agent: "hole-finder-safety",
    provider: "openai",
    model: "gpt-5.6-luna",
    effort: "high",
  });
  assert.deepEqual(rows[1], {
    agent: "hole-finder-cost",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    effort: undefined,
  });
});

test("parseDispatchTable：缺首行 format marker 即中止（exit 2）", () => {
  const md = `# dispatch ticket-001

| agent | provider | model | effort |
| --- | --- | --- | --- |
| a | openai | m | |
`;
  assert.throws(() => parseDispatchTable(md), (err: unknown) => {
    assert.ok(err instanceof DispatchError);
    assert.equal(err.exitCode, 2);
    return true;
  });
});

test("parseDispatchTable：model 留白視為缺失", () => {
  const md = `<!-- format: v1 -->
| agent | provider | model | effort |
| --- | --- | --- | --- |
| a | openai |  | |
`;
  assert.throws(() => parseDispatchTable(md), DispatchError);
});

test("parseDispatchTable：model 寫 default 視為缺失（不得套預設值）", () => {
  const md = `<!-- format: v1 -->
| agent | provider | model | effort |
| --- | --- | --- | --- |
| a | openai | default | |
`;
  assert.throws(() => parseDispatchTable(md), DispatchError);
});

test("parseSharedDoc：待審段落缺失即中止", () => {
  const md = `# 前提（不受審）
- 一行結論
`;
  assert.throws(() => parseSharedDoc(md), (err: unknown) => {
    assert.ok(err instanceof DispatchError);
    assert.equal((err as DispatchError).exitCode, 2);
    return true;
  });
});

// issue_log_v2.1.md：實測撞過兩次的情境——規劃書自帶 `#` 標題，把待審段落切斷。
// 訊息必須指名兇手，不能只說「缺或內容為空」，否則讀的人會先去查自己有沒有寫。
test("parseSharedDoc：待審段落被內嵌規劃書的 # 標題切斷時，訊息須指名是哪個標題", () => {
  const md = `# 前提（不受審）
- 無

# 待審段落

# plan_dispatch — v2.2（差異版）
規劃書本體全部落在這裡，待審段落其實是空的。
`;
  assert.throws(
    () => parseSharedDoc(md),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal((err as DispatchError).exitCode, 2);
      const msg = (err as DispatchError).message;
      assert.match(msg, /切斷/, "訊息須說明是被切斷，而非缺失");
      assert.match(msg, /plan_dispatch — v2\.2（差異版）/, "訊息須指名切斷它的標題");
      assert.match(msg, /降成/, "訊息須給出處置（降成 ##）");
      return true;
    },
  );
});

// 標題根本沒寫時，仍走原本的訊息——兩種成因不可混為一談。
test("parseSharedDoc：待審段落完全沒寫時，維持原訊息（不誤報為被切斷）", () => {
  const md = `# 前提（不受審）
- 無
`;
  assert.throws(
    () => parseSharedDoc(md),
    (err: unknown) => {
      assert.match((err as DispatchError).message, /缺「# 待審段落」或內容為空/);
      assert.doesNotMatch((err as DispatchError).message, /切斷/);
      return true;
    },
  );
});

test("parseSharedDoc：前提缺失時合法（空前提，警告不中止）", () => {
  const md = `# 待審段落
規劃書原文逐字內嵌
`;
  const shared = parseSharedDoc(md);
  assert.deepEqual(shared.premises, []);
  assert.equal(shared.reviewText, "規劃書原文逐字內嵌");
});

test("parseSharedDoc：前提解析為條列陣列", () => {
  const md = `# 前提（不受審）
- 前提一
- 前提二

# 待審段落
內容
`;
  const shared = parseSharedDoc(md);
  assert.deepEqual(shared.premises, ["前提一", "前提二"]);
});

test("parseAgentTicket：具體問題缺失即中止", () => {
  const md = `# 允許讀取
- src/foo.ts
`;
  assert.throws(() => parseAgentTicket(md), DispatchError);
});

test("parseAgentTicket：允許讀取缺失時合法（空清單）", () => {
  const md = `# 具體問題
1. 問題一
`;
  const t = parseAgentTicket(md);
  assert.deepEqual(t.allowedReads, []);
  assert.match(t.questions, /問題一/);
});

test("parseAgentTicket：允許讀取解析為相對路徑陣列", () => {
  const md = `# 具體問題
1. 問題一

# 允許讀取
- src/foo.ts
- src/bar.ts
`;
  const t = parseAgentTicket(md);
  assert.deepEqual(t.allowedReads, ["src/foo.ts", "src/bar.ts"]);
});
