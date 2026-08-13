import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRawArrayIntegrity, checkRawObjectIntegrity, RawIntegrityError } from "./raw-integrity.js";
import type { Conversation } from "./types.js";

test("checkRawArrayIntegrity：raw 全部出現在 input 中 → 不拋錯", () => {
  const reasoningItem = { type: "reasoning", id: "r1", encrypted_content: "abc" };
  const functionCallItem = { type: "function_call", id: "fc1", call_id: "call_1", name: "read_file" };
  const conv: Conversation = {
    systemPrompt: "sys",
    turns: [
      { role: "user", text: "hi" },
      { role: "assistant", raw: [reasoningItem, functionCallItem], toolCalls: [] },
    ],
  };
  const builtInput = [{ role: "user" }, reasoningItem, functionCallItem];
  assert.doesNotThrow(() => checkRawArrayIntegrity(conv, builtInput, "zh"));
});

test("checkRawArrayIntegrity：漏帶其中一個 item（Test C 那種過濾 bug）→ 拋 RawIntegrityError", () => {
  const reasoningItem = { type: "reasoning", id: "r1", encrypted_content: "abc" };
  const functionCallItem = { type: "function_call", id: "fc1", call_id: "call_1", name: "read_file" };
  const conv: Conversation = {
    systemPrompt: "sys",
    turns: [
      { role: "user", text: "hi" },
      { role: "assistant", raw: [reasoningItem, functionCallItem], toolCalls: [] },
    ],
  };
  // 模擬「只留 function_call，過濾掉 reasoning item」的錯誤心智模型（facts Test C 的成因）
  const builtInputMissingReasoning = [{ role: "user" }, functionCallItem];
  assert.throws(
    () => checkRawArrayIntegrity(conv, builtInputMissingReasoning, "zh"),
    (err: unknown) => {
      assert.ok(err instanceof RawIntegrityError);
      assert.match(err.message, /reasoning/);
      return true;
    },
  );
});

test("checkRawArrayIntegrity：raw 不是陣列（形狀錯誤）→ 拋錯，不靜默放行", () => {
  const conv: Conversation = {
    systemPrompt: "sys",
    turns: [{ role: "assistant", raw: { not: "an array" }, toolCalls: [] }],
  };
  assert.throws(() => checkRawArrayIntegrity(conv, [], "zh"), RawIntegrityError);
});

test("checkRawArrayIntegrity：多個 assistant turn，每個都要驗證，不只驗最後一個", () => {
  const item1 = { type: "message", id: "m1" };
  const item2 = { type: "function_call", id: "fc1" };
  const conv: Conversation = {
    systemPrompt: "sys",
    turns: [
      { role: "user", text: "hi" },
      { role: "assistant", raw: [item1], toolCalls: [] },
      { role: "tool", callId: "fc1", result: "ok" },
      { role: "assistant", raw: [item2], toolCalls: [] },
    ],
  };
  // 只把第一輪的 item 放進 input，第二輪的漏掉
  assert.throws(() => checkRawArrayIntegrity(conv, [item1], "zh"), RawIntegrityError);
  // 兩輪都在才過
  assert.doesNotThrow(() => checkRawArrayIntegrity(conv, [item1, item2], "zh"));
});

test("checkRawArrayIntegrity：user/tool turn 不受檢查（只驗 assistant）", () => {
  const conv: Conversation = {
    systemPrompt: "sys",
    turns: [
      { role: "user", text: "hi" },
      { role: "tool", callId: "x", result: "y" },
    ],
  };
  assert.doesNotThrow(() => checkRawArrayIntegrity(conv, [], "zh"));
});

test("checkRawObjectIntegrity（gemini-native 形狀）：raw 整個物件出現在 contents → 不拋錯", () => {
  const modelContent = { role: "model", parts: [{ functionCall: { name: "read_file", args: {} } }] };
  const conv: Conversation = {
    systemPrompt: "sys",
    turns: [
      { role: "user", text: "hi" },
      { role: "assistant", raw: modelContent, toolCalls: [] },
    ],
  };
  const builtContents = [{ role: "user", parts: [{ text: "hi" }] }, modelContent];
  assert.doesNotThrow(() => checkRawObjectIntegrity(conv, builtContents, "zh"));
});

test("checkRawObjectIntegrity：raw 被重建成結構相似但非同一物件（例如漏帶 thoughtSignature）→ 拋錯", () => {
  const modelContent = {
    role: "model",
    parts: [{ functionCall: { name: "read_file", args: {} }, thoughtSignature: "sig123" }],
  };
  // 結構相似、但少了 thoughtSignature 的複製品——參照不同，代表被重建過
  const rebuiltCopy = { role: "model", parts: [{ functionCall: { name: "read_file", args: {} } }] };
  const conv: Conversation = {
    systemPrompt: "sys",
    turns: [{ role: "assistant", raw: modelContent, toolCalls: [] }],
  };
  assert.throws(() => checkRawObjectIntegrity(conv, [rebuiltCopy], "zh"), RawIntegrityError);
});

// T7a2：三個拋錯點先前完全未走 messages.ts，--lang en 下產生「英文外殼＋中文內容」
// （runner.ts 的 rawIntegrityCheckFailed 已英文化，但包住的 err.message 是這三則之一）。
// 逐一鎖住 zh／en 的完整訊息文字，不只驗「有沒有拋錯」。
test("checkRawArrayIntegrity：raw 不是陣列——訊息依 lang 輸出（zh／en）", () => {
  const conv: Conversation = {
    systemPrompt: "sys",
    turns: [{ role: "assistant", raw: { not: "an array" }, toolCalls: [] }],
  };
  assert.throws(
    () => checkRawArrayIntegrity(conv, [], "zh"),
    (err: unknown) =>
      err instanceof RawIntegrityError &&
      err.message ===
        "raw 完整性檢查失敗：assistant turn 的 raw 不是陣列（responses adapter 預期 raw 為上一輪 response.output 陣列）",
  );
  assert.throws(
    () => checkRawArrayIntegrity(conv, [], "en"),
    (err: unknown) =>
      err instanceof RawIntegrityError &&
      err.message ===
        "Raw integrity check failed: assistant turn's raw is not an array (the responses adapter expects raw to be the prior round's response.output array)",
  );
});

test("checkRawArrayIntegrity：item 漏帶——訊息依 lang 輸出，插值帶 type（zh／en）", () => {
  const item = { type: "reasoning", id: "r1" };
  const conv: Conversation = {
    systemPrompt: "sys",
    turns: [{ role: "assistant", raw: [item], toolCalls: [] }],
  };
  assert.throws(
    () => checkRawArrayIntegrity(conv, [], "zh"),
    (err: unknown) =>
      err instanceof RawIntegrityError &&
      err.message ===
        "raw 完整性檢查失敗：assistant turn 有一個 item（type=reasoning）未以原樣出現在送出的請求中，疑似續接時被過濾掉",
  );
  assert.throws(
    () => checkRawArrayIntegrity(conv, [], "en"),
    (err: unknown) =>
      err instanceof RawIntegrityError &&
      err.message ===
        "Raw integrity check failed: an assistant-turn item (type=reasoning) was not found verbatim in the outgoing request — possibly filtered out during continuation",
  );
});

test("checkRawObjectIntegrity：raw 未原樣出現——訊息依 lang 輸出（zh／en）", () => {
  const modelContent = { role: "model", parts: [] };
  const conv: Conversation = {
    systemPrompt: "sys",
    turns: [{ role: "assistant", raw: modelContent, toolCalls: [] }],
  };
  assert.throws(
    () => checkRawObjectIntegrity(conv, [], "zh"),
    (err: unknown) =>
      err instanceof RawIntegrityError &&
      err.message ===
        "raw 完整性檢查失敗：assistant turn 的 raw 未以原樣出現在送出的 contents 中，疑似續接時被重建或漏帶",
  );
  assert.throws(
    () => checkRawObjectIntegrity(conv, [], "en"),
    (err: unknown) =>
      err instanceof RawIntegrityError &&
      err.message ===
        "Raw integrity check failed: assistant turn's raw was not found verbatim in the outgoing contents — possibly rebuilt or dropped during continuation",
  );
});
