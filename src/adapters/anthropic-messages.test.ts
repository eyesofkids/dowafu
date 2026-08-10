import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnthropicRequest } from "./anthropic-messages.js";
import type { Conversation, ReasoningConfig } from "../types.js";

const ANTHROPIC_CONFIG: { reasoning: ReasoningConfig } = {
  reasoning: { style: "anthropic", allowed: ["low", "medium", "high", "xhigh", "max"], default: "high" },
};

// plan_dispatch_v2.7.md §29 規格三十第 1 條：本條是本版的核心——擋的是「唯一會讓整個
// provider 完全不能用的錯」（thinking.type:"enabled" 在 Opus 5／Sonnet 5 上 400），不需打
// API 就能測出來。

test("buildAnthropicRequest：system 在 top-level、工具用 input_schema、thinking.type 為 adaptive、不含 budget_tokens", () => {
  const conv: Conversation = { systemPrompt: "system prompt", turns: [{ role: "user", text: "hi" }] };
  const params = buildAnthropicRequest(conv, { model: "claude-sonnet-5", effort: "high" }, ANTHROPIC_CONFIG) as Record<
    string,
    unknown
  >;

  assert.equal(params.system, "system prompt");
  const tools = params.tools as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(tools) && tools.length > 0);
  assert.ok("input_schema" in tools[0], "工具 schema 欄位須為 input_schema，不是 parameters");
  assert.equal("parameters" in tools[0], false);

  const thinking = params.thinking as Record<string, unknown>;
  assert.equal(thinking.type, "adaptive");
  assert.equal("budget_tokens" in thinking, false, "adaptive thinking 不得帶 budget_tokens（那是舊路徑，會 400）");

  const outputConfig = params.output_config as Record<string, unknown>;
  assert.equal(outputConfig.effort, "high");
});

test("buildAnthropicRequest：不含 max_tokens 為 0 或缺席，且不含 store 欄位（Messages API 無此參數）", () => {
  const conv: Conversation = { systemPrompt: "s", turns: [{ role: "user", text: "hi" }] };
  const params = buildAnthropicRequest(conv, { model: "claude-sonnet-5", effort: "high" }, ANTHROPIC_CONFIG) as Record<
    string,
    unknown
  >;
  assert.ok(typeof params.max_tokens === "number" && (params.max_tokens as number) > 0);
  assert.equal("store" in params, false);
  assert.deepEqual(params.cache_control, { type: "ephemeral" });
});

test("buildAnthropicRequest：enableTools:false（收束呼叫）不帶 tools 欄位", () => {
  const conv: Conversation = { systemPrompt: "s", turns: [{ role: "user", text: "hi" }] };
  const params = buildAnthropicRequest(
    conv,
    { model: "claude-sonnet-5", effort: "high", enableTools: false },
    ANTHROPIC_CONFIG,
  ) as Record<string, unknown>;
  assert.equal("tools" in params, false);
});

// 規格三十第 2 條：連續兩個 tool turn 必須合併成一則 user message、含兩個 tool_result
// block——逐筆送出會產生連續兩則 user message，Anthropic 不接受這種形態（規格五）。
test("buildAnthropicRequest：連續兩個 tool turn 合併成一則 user message，內含兩個 tool_result block", () => {
  const toolUseBlock1 = { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } };
  const toolUseBlock2 = { type: "tool_use", id: "call_2", name: "read_file", input: { path: "b.ts" } };
  const assistantRaw = { role: "assistant", content: [toolUseBlock1, toolUseBlock2] };

  const conv: Conversation = {
    systemPrompt: "s",
    turns: [
      { role: "user", text: "請讀取兩個檔案" },
      { role: "assistant", raw: assistantRaw, toolCalls: [] },
      { role: "tool", callId: "call_1", result: "內容 A" },
      { role: "tool", callId: "call_2", result: "內容 B" },
    ],
  };

  const params = buildAnthropicRequest(conv, { model: "claude-sonnet-5", effort: "high" }, ANTHROPIC_CONFIG) as Record<
    string,
    unknown
  >;
  const messages = params.messages as Array<{ role: string; content: unknown }>;

  // user、assistant、合併後的 user（不是 user、assistant、user、user 四則）
  assert.equal(messages.length, 3);
  const mergedMessage = messages[2];
  assert.equal(mergedMessage.role, "user");
  const toolResults = mergedMessage.content as Array<Record<string, unknown>>;
  assert.equal(toolResults.length, 2, "兩個 tool turn 須合併成一則 message 內的兩個 tool_result block");
  assert.deepEqual(toolResults[0], { type: "tool_result", tool_use_id: "call_1", content: "內容 A" });
  assert.deepEqual(toolResults[1], { type: "tool_result", tool_use_id: "call_2", content: "內容 B" });
});

// 規格三十第 3 條：assistant turn 的 raw（含 thinking block）須以參照相等原樣出現在
// messages 中——過濾掉 thinking block 是「過濾條件寫錯一行就會發生」的那種錯誤（§8）。
test("buildAnthropicRequest：assistant turn 的 raw（含 thinking block）以參照相等原樣出現在 messages 中", () => {
  const thinkingBlock = { type: "thinking", thinking: "...", signature: "sig-abc" };
  const textBlock = { type: "text", text: "答案" };
  const assistantRaw = { role: "assistant", content: [thinkingBlock, textBlock] };

  const conv: Conversation = {
    systemPrompt: "s",
    turns: [
      { role: "user", text: "問題" },
      { role: "assistant", raw: assistantRaw, toolCalls: [] },
      { role: "user", text: "追問" },
    ],
  };

  const params = buildAnthropicRequest(conv, { model: "claude-sonnet-5", effort: "high" }, ANTHROPIC_CONFIG) as Record<
    string,
    unknown
  >;
  const messages = params.messages as unknown[];
  assert.ok(messages.includes(assistantRaw), "assistant turn 的 raw 物件應以參照相等原樣出現在 messages 中");
  const assistantMessage = messages[1] as { content: unknown[] };
  assert.ok(assistantMessage.content.includes(thinkingBlock), "thinking block 不得被過濾掉");
});

// 注意：與 gemini-native 同理（見 gemini-native.test.ts 開頭註解）——turnsToMessages 對
// assistant turn 是直接把 turn.raw 本身放進 messages，經由 buildAnthropicRequest 這個公開
// 函式無法在正常使用下組出「raw 被過濾掉」的請求；checkRawObjectIntegrity 本身的迴歸測試
// 在 raw-integrity.test.ts（已涵蓋兩種物件形狀共用的這個函式，非本檔職責）。
