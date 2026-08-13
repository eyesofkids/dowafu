import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGeminiRequest } from "./gemini-native.js";
import type { Conversation } from "../types.js";

// plan_dispatch_v1.5.md §8：同一份自我檢查兩家 adapter 都要做——gemini 這側雖然
// thoughtSignature 漏帶已知會被 API 擋下（400），但其他 part 漏帶的行為未測，
// 「一體適用比較安全」（使用者原話），故不倚賴 API 行為差異。
//
// 注意：gemini-native 的 turnToContent 對 assistant turn 是直接回傳 turn.raw 本身
// （不像 responses adapter 有陣列展開），因此經由 buildGeminiRequest 這個公開函式
// 無法在正常使用下組出「raw 被過濾掉」的請求——這條檢查真正會抓到迴歸的地方是
// raw-integrity.test.ts 對 checkRawObjectIntegrity 的直接測試（那裡構造了不同參照的
// builtContents 來模擬「turnToContent 被改成重建新物件」的情境）。這裡驗證的是正確接線：
// 正常組裝不會誤觸發自我檢查，且 raw 確實以參照原樣進入請求。

test("buildGeminiRequest：完整 conversation 組裝成功，raw 整個物件以參照出現在 contents 中", () => {
  const modelContent = {
    role: "model",
    parts: [{ functionCall: { name: "read_file", args: { path: "a" } }, thoughtSignature: "sig-abc" }],
  };
  const conv: Conversation = {
    systemPrompt: "system",
    turns: [
      { role: "user", text: "第一個 user turn" },
      { role: "assistant", raw: modelContent, toolCalls: [] },
      { role: "tool", callId: "call-1", result: "檔案內容" },
    ],
  };

  const { contents, body } = buildGeminiRequest(conv, { model: "gemini-3.1-flash-lite" }, "zh");

  assert.ok(contents.includes(modelContent), "assistant turn 的 raw 應以原樣（同一參照）出現在 contents 中");
  assert.deepEqual((body as { system_instruction: unknown }).system_instruction, { parts: [{ text: "system" }] });
});

test("buildGeminiRequest：多輪 assistant turn 都要各自完整出現，不是只驗最後一輪", () => {
  const first = { role: "model", parts: [{ text: "first" }] };
  const second = { role: "model", parts: [{ text: "second" }] };
  const conv: Conversation = {
    systemPrompt: "s",
    turns: [
      { role: "user", text: "hi" },
      { role: "assistant", raw: first, toolCalls: [] },
      { role: "user", text: "續問" },
      { role: "assistant", raw: second, toolCalls: [] },
    ],
  };
  const { contents } = buildGeminiRequest(conv, { model: "gemini-3.1-flash-lite" }, "zh");
  assert.ok(contents.includes(first));
  assert.ok(contents.includes(second));
});

test("buildGeminiRequest：enableTools:false（收束呼叫）不帶 tools 欄位", () => {
  const conv: Conversation = { systemPrompt: "s", turns: [{ role: "user", text: "hi" }] };
  const { body } = buildGeminiRequest(conv, { model: "gemini-3.1-flash-lite", enableTools: false }, "zh");
  assert.equal("tools" in body, false);
});

test("buildGeminiRequest：enableTools 預設（未指定）帶 tools 欄位", () => {
  const conv: Conversation = { systemPrompt: "s", turns: [{ role: "user", text: "hi" }] };
  const { body } = buildGeminiRequest(conv, { model: "gemini-3.1-flash-lite" }, "zh");
  assert.equal("tools" in body, true);
});

test("buildGeminiRequest：effort 有值時送 generationConfig.thinkingConfig.thinkingLevel（camelCase，v1.8 §5 實測正確路徑）", () => {
  const conv: Conversation = { systemPrompt: "s", turns: [{ role: "user", text: "hi" }] };
  const { body } = buildGeminiRequest(conv, { model: "gemini-3.1-flash-lite", effort: "high" }, "zh");
  assert.deepEqual((body as { generationConfig: unknown }).generationConfig, {
    thinkingConfig: { thinkingLevel: "high" },
  });
});

test("buildGeminiRequest：effort 留白則不送 generationConfig（v1.7 §5 舊行為：頂層 thinking_level 會 400，此前完全未接線）", () => {
  const conv: Conversation = { systemPrompt: "s", turns: [{ role: "user", text: "hi" }] };
  const { body } = buildGeminiRequest(conv, { model: "gemini-3.1-flash-lite" }, "zh");
  assert.equal("generationConfig" in body, false);
});

// i18n_classification_t2.md §三之3：read_file 工具 description 是 C 類雙語常數，由
// lang 參數選用，三支 adapter 共用同一組常數（見 read-file-tool-description.ts）。
test("buildGeminiRequest：read_file 工具的 description 依 lang 換語言（zh／en，手寫字面量）", () => {
  const conv: Conversation = { systemPrompt: "s", turns: [{ role: "user", text: "hi" }] };
  const { body: bodyZh } = buildGeminiRequest(conv, { model: "gemini-3.1-flash-lite" }, "zh");
  const toolsZh = (bodyZh as { tools: Array<{ functionDeclarations: Array<{ description: string }> }> }).tools;
  assert.equal(toolsZh[0].functionDeclarations[0].description, "讀取指定路徑的檔案內容");

  const { body: bodyEn } = buildGeminiRequest(conv, { model: "gemini-3.1-flash-lite" }, "en");
  const toolsEn = (bodyEn as { tools: Array<{ functionDeclarations: Array<{ description: string }> }> }).tools;
  assert.equal(toolsEn[0].functionDeclarations[0].description, "Read the contents of the file at the given path.");
});
