import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResponsesRequest, type ResponsesAdapterConfig } from "./responses.js";
import { RawIntegrityError } from "../raw-integrity.js";
import type { Conversation } from "../types.js";

const OPENAI_CONFIG: ResponsesAdapterConfig = {
  baseURL: "https://api.openai.com/v1",
  apiKey: "unused-in-this-test",
  store: false,
  reasoning: { style: "openai", allowed: ["medium"] },
  lang: "zh",
};

const DEEPSEEK_CONFIG: ResponsesAdapterConfig = {
  baseURL: "https://api.deepseek.com/v1",
  apiKey: "unused-in-this-test",
  store: false,
  reasoning: { style: "deepseek", allowed: [] },
  lang: "zh",
};

// plan_dispatch_v1.5.md §8：「構造含 assistant turn 的 conversation，呼叫 adapter 的
// 組裝函式，比對輸出」——不需要打 API，因為自我檢查發生在網路呼叫之前。

test("buildResponsesRequest：完整 conversation 組裝成功，raw 逐一以參照出現在 input 中", () => {
  const reasoningItem = { type: "reasoning", id: "r1", encrypted_content: "abc" };
  const functionCallItem = { type: "function_call", id: "fc1", call_id: "call_1", name: "read_file", arguments: "{}" };
  const conv: Conversation = {
    systemPrompt: "system",
    turns: [
      { role: "user", text: "第一個 user turn" },
      { role: "assistant", raw: [reasoningItem, functionCallItem], toolCalls: [] },
      { role: "tool", callId: "call_1", result: "檔案內容" },
    ],
  };

  const params = buildResponsesRequest(conv, { model: "gpt-5.6-luna" }, OPENAI_CONFIG);

  assert.ok(Array.isArray(params.input));
  assert.ok((params.input as unknown[]).includes(reasoningItem), "reasoning item 應以原樣出現在 input 中");
  assert.ok((params.input as unknown[]).includes(functionCallItem), "function_call item 應以原樣出現在 input 中");
  assert.equal(params.store, false);
  assert.equal(params.instructions, "system");
});

test("buildResponsesRequest：assistant turn 的 raw 形狀錯誤（非陣列）→ 拋 RawIntegrityError，不送出請求", () => {
  const conv: Conversation = {
    systemPrompt: "system",
    turns: [{ role: "assistant", raw: { corrupted: true }, toolCalls: [] }],
  };
  assert.throws(() => buildResponsesRequest(conv, { model: "gpt-5.6-luna" }, OPENAI_CONFIG), RawIntegrityError);
});

test("buildResponsesRequest：effort 有值時依 reasoning.style 轉成對應參數（openai）", () => {
  const conv: Conversation = { systemPrompt: "s", turns: [{ role: "user", text: "hi" }] };
  const params = buildResponsesRequest(conv, { model: "gpt-5.6-luna", effort: "medium" }, OPENAI_CONFIG) as unknown as Record<string, unknown>;
  assert.deepEqual(params.reasoning, { effort: "medium" });
});

test("buildResponsesRequest：effort 有值時依 reasoning.style 轉成對應參數（deepseek，v1.8 §5 實測正確路徑 output_config.effort）", () => {
  const conv: Conversation = { systemPrompt: "s", turns: [{ role: "user", text: "hi" }] };
  const params = buildResponsesRequest(conv, { model: "deepseek-v4-flash", effort: "high" }, DEEPSEEK_CONFIG) as unknown as Record<string, unknown>;
  assert.deepEqual(params.output_config, { effort: "high" });
  assert.equal("thinking" in params, false, "v1.7 的舊路徑（thinking/reasoning_effort）對 /v1/responses 靜默不生效，不應再送出");
  assert.equal("reasoning_effort" in params, false);
});

test("buildResponsesRequest：effort 留白則不送任何 reasoning 參數（§4：用該家預設）", () => {
  const conv: Conversation = { systemPrompt: "s", turns: [{ role: "user", text: "hi" }] };
  const params = buildResponsesRequest(conv, { model: "gpt-5.6-luna" }, OPENAI_CONFIG) as unknown as Record<
    string,
    unknown
  >;
  assert.equal("reasoning" in params, false);
});

test("buildResponsesRequest：enableTools:false（收束呼叫）不帶 tools 欄位", () => {
  const conv: Conversation = { systemPrompt: "s", turns: [{ role: "user", text: "hi" }] };
  const params = buildResponsesRequest(conv, { model: "gpt-5.6-luna", enableTools: false }, OPENAI_CONFIG) as unknown as Record<string, unknown>;
  assert.equal("tools" in params, false);
});

// i18n_classification_t2.md §三之3：read_file 工具 description 是 C 類雙語常數，由
// config.lang 選用，三支 adapter 共用同一組常數（見 read-file-tool-description.ts）。
test("buildResponsesRequest：read_file 工具的 description 依 config.lang 換語言（zh／en，手寫字面量）", () => {
  const conv: Conversation = { systemPrompt: "s", turns: [{ role: "user", text: "hi" }] };
  const paramsZh = buildResponsesRequest(conv, { model: "gpt-5.6-luna" }, OPENAI_CONFIG) as unknown as {
    tools: Array<{ description: string }>;
  };
  assert.equal(paramsZh.tools[0].description, "讀取指定路徑的檔案內容");

  const paramsEn = buildResponsesRequest(conv, { model: "gpt-5.6-luna" }, { ...OPENAI_CONFIG, lang: "en" }) as unknown as {
    tools: Array<{ description: string }>;
  };
  assert.equal(paramsEn.tools[0].description, "Read the contents of the file at the given path.");
});
