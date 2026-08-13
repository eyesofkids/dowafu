// _docs/dispatch/plan_dispatch_v1.2.md §19「實作第一步」：最小驗證腳本。
//
// 介面依 provider 分岔（見 _docs/dispatch/issue_log_v1.md 2026-08-05 條目，使用者裁決）：
// - openai／deepseek：走 /v1/responses（openai 的 gpt-5.6 系列在 /v1/chat/completions
//   上 tools 與 reasoning_effort 不相容；/v1/responses 原生支援兩者並存，deepseek 兩個
//   端點都通，優先選對 openai 有解的那個）。
// - gemini：不套 OpenAI 相容殼，改打原生 generateContent（實測 openai 相容殼不支援
//   /responses；且使用者裁示 gemini 不必侷限於 openai 格式）。
//
// 記錄項目不變：能否 tool-calling、usage 是否逐輪回傳、model 欄是否對得上請求值
// （抓 fallback）、429 時的 header／訊息格式。結果決定 providers.json 的內容，
// 不通就回頭修 plan（§19 明寫），不硬改本腳本去遷就規劃書。

// plan_dispatch_v1.11.md §26：金鑰只該有一個位置——與 CLI 同一條載入路徑
// （$DISPATCH_HOME/.env，ambient 優先），不讀 cwd 的 .env（§24.4 禁令對此腳本雖不
// 直接適用，但雙來源會讓「repo 的 .env 到底還要不要留」變成無法從程式碼看出答案的狀態）。
import { loadDispatchEnv, resolveDispatchHome } from "../src/dispatch-home.js";
import OpenAI from "openai";
import { writeFile, mkdir } from "node:fs/promises";

const dispatchHome = resolveDispatchHome();
if (dispatchHome !== null) loadDispatchEnv(dispatchHome);

const USER_PROMPT =
  '請呼叫 read_file 工具讀取路徑 "package.json"，並用一句話告訴我它的 "name" 欄位值。';
const FAKE_TOOL_RESULT = '{"name":"dowafu"}';

// ---------------------------------------------------------------------------
// §11：API key 不得出現在任何落檔、stdout 或錯誤訊息中。
// ---------------------------------------------------------------------------

const API_KEY_ENVS = ["DEEPSEEK_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
const secretValues = API_KEY_ENVS.map((k) => process.env[k]).filter(
  (v): v is string => Boolean(v && v.length > 0),
);

function maskString(input: string): string {
  let out = input;
  for (const secret of secretValues) {
    out = out.split(secret).join("***REDACTED***");
  }
  out = out.replace(/sk-[A-Za-z0-9]{10,}/g, "***REDACTED***");
  out = out.replace(/ghp_[A-Za-z0-9]{10,}/g, "***REDACTED***");
  out = out.replace(/AIza[A-Za-z0-9_-]{10,}/g, "***REDACTED***");
  return out;
}

const REDACTED_HEADER_KEYS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
]);

function maskHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (REDACTED_HEADER_KEYS.has(key.toLowerCase())) {
      out[key] = "***REDACTED***";
    } else {
      out[key] = maskString(String(value));
    }
  }
  return out;
}

// 刻意不對 error 物件做 JSON.stringify(error)（§11 明文警告：SDK 的 error 物件
// 可能帶著 request headers，裡面就是完整金鑰）。改為白名單挑欄位、逐欄遮蔽。
// 同時服務 OpenAI SDK 的 APIError 與本檔 Gemini fetch 路徑自製的 error 物件。
function describeError(err: unknown): Record<string, unknown> {
  if (err && typeof err === "object") {
    const anyErr = err as Record<string, unknown>;
    const status = typeof anyErr.status === "number" ? anyErr.status : undefined;
    const headers = maskHeaders(anyErr.headers);
    const message = typeof anyErr.message === "string" ? maskString(anyErr.message) : undefined;
    const errorBody =
      anyErr.error && typeof anyErr.error === "object"
        ? { message: maskString(JSON.stringify(anyErr.error)) }
        : undefined;
    const retryAfter =
      headers?.["retry-after"] ?? headers?.["Retry-After"] ?? undefined;
    return {
      status,
      is429: status === 429,
      retryAfterHeader: retryAfter ?? null,
      message,
      errorBody,
      headers,
    };
  }
  return { message: maskString(String(err)) };
}

type RoundRecord = {
  round: number;
  modelReturned: string | null;
  usage: unknown;
  hasToolCalls: boolean;
  finishReason: string | null;
};

type ProviderResult = {
  provider: string;
  modelRequested: string;
  ok: boolean;
  toolCalling: boolean | null; // null = 無法判定（呼叫本身失敗）
  usagePresentEveryRound: boolean | null;
  rounds: RoundRecord[];
  error: Record<string, unknown> | null;
};

function emptyResult(provider: string, model: string): ProviderResult {
  return {
    provider,
    modelRequested: model,
    ok: false,
    toolCalling: null,
    usagePresentEveryRound: null,
    rounds: [],
    error: null,
  };
}

// ---------------------------------------------------------------------------
// openai / deepseek — /v1/responses
// ---------------------------------------------------------------------------

type ResponsesProviderConfig = {
  name: "deepseek" | "openai";
  baseURL?: string;
  apiKeyEnv: string;
  modelEnv: string;
  defaultModel: string;
  // deepseek 的 /v1/responses 不儲存伺服器端狀態（response.store === false），
  // previous_response_id 續接會 400；須整段歷史重送。openai 支援 previous_response_id。
  stateful: boolean;
  extraParams?: Record<string, unknown>;
};

const RESPONSES_PROVIDERS: ResponsesProviderConfig[] = [
  {
    name: "deepseek",
    baseURL: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    modelEnv: "DEEPSEEK_MODEL",
    defaultModel: "deepseek-v4-flash",
    stateful: false,
  },
  {
    name: "openai",
    apiKeyEnv: "OPENAI_API_KEY",
    modelEnv: "OPENAI_MODEL",
    defaultModel: "gpt-5.6-luna",
    stateful: true,
    // 保留推理能力（對照使用者透過 VSCode Copilot 實測成功的 medium）；
    // 這正是選 /v1/responses 而非 /v1/chat/completions 的理由。
    extraParams: { reasoning: { effort: "medium" } },
  },
];

const RESPONSES_READ_FILE_TOOL: OpenAI.Responses.FunctionTool = {
  type: "function",
  name: "read_file",
  description: "讀取指定路徑的檔案內容",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  strict: false,
};

async function verifyResponsesProvider(
  config: ResponsesProviderConfig,
): Promise<ProviderResult> {
  const apiKey = process.env[config.apiKeyEnv];
  const model = process.env[config.modelEnv] || config.defaultModel;
  const result = emptyResult(config.name, model);

  if (!apiKey) {
    result.error = { message: `缺少環境變數 ${config.apiKeyEnv}，跳過` };
    return result;
  }

  const client = new OpenAI({ apiKey, baseURL: config.baseURL });

  try {
    const first = await client.responses.create({
      model,
      input: USER_PROMPT,
      tools: [RESPONSES_READ_FILE_TOOL],
      ...config.extraParams,
    } as OpenAI.Responses.ResponseCreateParamsNonStreaming);

    const firstFunctionCalls = first.output.filter(
      (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call",
    );
    result.rounds.push({
      round: 1,
      modelReturned: first.model ?? null,
      usage: first.usage ?? null,
      hasToolCalls: firstFunctionCalls.length > 0,
      finishReason: first.status ?? null,
    });

    if (firstFunctionCalls.length === 0) {
      result.toolCalling = false;
      result.usagePresentEveryRound = Boolean(first.usage);
      result.ok = true;
      return result;
    }

    result.toolCalling = true;

    const functionOutputs: OpenAI.Responses.ResponseInputItem.FunctionCallOutput[] =
      firstFunctionCalls.map((call) => ({
        type: "function_call_output",
        call_id: call.call_id,
        output: FAKE_TOOL_RESULT,
      }));

    const second = config.stateful
      ? await client.responses.create({
          model,
          previous_response_id: first.id,
          input: functionOutputs,
          tools: [RESPONSES_READ_FILE_TOOL],
          ...config.extraParams,
        } as OpenAI.Responses.ResponseCreateParamsNonStreaming)
      : await client.responses.create({
          model,
          input: [
            { role: "user", content: [{ type: "input_text", text: USER_PROMPT }] },
            ...first.output,
            ...functionOutputs,
          ],
          tools: [RESPONSES_READ_FILE_TOOL],
          ...config.extraParams,
        } as OpenAI.Responses.ResponseCreateParamsNonStreaming);

    const secondFunctionCalls = second.output.filter(
      (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call",
    );
    result.rounds.push({
      round: 2,
      modelReturned: second.model ?? null,
      usage: second.usage ?? null,
      hasToolCalls: secondFunctionCalls.length > 0,
      finishReason: second.status ?? null,
    });

    result.usagePresentEveryRound = result.rounds.every((r) => Boolean(r.usage));
    result.ok = true;
    return result;
  } catch (err) {
    result.error = describeError(err);
    return result;
  }
}

// ---------------------------------------------------------------------------
// gemini — 原生 generateContent（不套 OpenAI 相容殼）
// ---------------------------------------------------------------------------

type GeminiConfig = {
  name: "gemini";
  apiKeyEnv: string;
  modelEnv: string;
  defaultModel: string;
};

const GEMINI_CONFIG: GeminiConfig = {
  name: "gemini",
  apiKeyEnv: "GEMINI_API_KEY",
  modelEnv: "GEMINI_MODEL",
  defaultModel: "gemini-3.1-flash-lite",
};

const GEMINI_TOOL = {
  functionDeclarations: [
    {
      name: "read_file",
      description: "讀取指定路徑的檔案內容",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
};

type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args: unknown; id?: string };
  functionResponse?: { name: string; response: unknown };
  // gemini-3.x：續接時要求原樣帶回上一輪 functionCall part 的 thoughtSignature，
  // 否則 400（"missing a thought_signature"）。
  thoughtSignature?: string;
};

// 只宣告本腳本實際讀取的欄位——回應還有很多其他欄位，這裡不求完整。
type GeminiNativeResponse = {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  modelVersion?: string;
  usageMetadata?: Record<string, number>;
};

async function callGeminiNative(
  apiKey: string,
  model: string,
  contents: Array<{ role: string; parts: GeminiPart[] }>,
): Promise<GeminiNativeResponse> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ contents, tools: [GEMINI_TOOL] }),
    },
  );
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(`Gemini native API ${res.status}`) as Error & {
      status?: number;
      headers?: Record<string, string>;
      error?: unknown;
    };
    err.status = res.status;
    err.headers = Object.fromEntries(res.headers.entries());
    err.error = body;
    throw err;
  }
  return body;
}

async function verifyGemini(config: GeminiConfig): Promise<ProviderResult> {
  const apiKey = process.env[config.apiKeyEnv];
  const model = process.env[config.modelEnv] || config.defaultModel;
  const result = emptyResult(config.name, model);

  if (!apiKey) {
    result.error = { message: `缺少環境變數 ${config.apiKeyEnv}，跳過` };
    return result;
  }

  try {
    const userTurn = { role: "user", parts: [{ text: USER_PROMPT }] };
    const first = await callGeminiNative(apiKey, model, [userTurn]);
    const firstCandidate = first.candidates?.[0];
    const firstParts: GeminiPart[] = firstCandidate?.content?.parts ?? [];
    const firstCall = firstParts.find((p) => p.functionCall);

    result.rounds.push({
      round: 1,
      modelReturned: first.modelVersion ?? null,
      usage: first.usageMetadata ?? null,
      hasToolCalls: Boolean(firstCall),
      finishReason: firstCandidate?.finishReason ?? null,
    });

    if (!firstCall) {
      result.toolCalling = false;
      result.usagePresentEveryRound = Boolean(first.usageMetadata);
      result.ok = true;
      return result;
    }

    result.toolCalling = true;

    const modelTurn = {
      role: "model",
      parts: [
        {
          functionCall: firstCall.functionCall,
          thoughtSignature: firstCall.thoughtSignature,
        },
      ],
    };
    const functionResponseTurn = {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: firstCall.functionCall!.name,
            response: JSON.parse(FAKE_TOOL_RESULT),
          },
        },
      ],
    };

    const second = await callGeminiNative(apiKey, model, [
      userTurn,
      modelTurn,
      functionResponseTurn,
    ]);
    const secondCandidate = second.candidates?.[0];
    const secondParts: GeminiPart[] = secondCandidate?.content?.parts ?? [];
    const secondCall = secondParts.find((p) => p.functionCall);

    result.rounds.push({
      round: 2,
      modelReturned: second.modelVersion ?? null,
      usage: second.usageMetadata ?? null,
      hasToolCalls: Boolean(secondCall),
      finishReason: secondCandidate?.finishReason ?? null,
    });

    result.usagePresentEveryRound = result.rounds.every((r) => Boolean(r.usage));
    result.ok = true;
    return result;
  } catch (err) {
    result.error = describeError(err);
    return result;
  }
}

// ---------------------------------------------------------------------------
// anthropic — 原生 Messages API（plan_dispatch_v2.7.md §29 規格十一：六項必須實測）
// ---------------------------------------------------------------------------

const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

const ANTHROPIC_READ_FILE_TOOL = {
  name: "read_file",
  description: "讀取指定路徑的檔案內容",
  input_schema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

// 同上：只宣告本腳本讀到的欄位。
type AnthropicContentBlock = { type: string; id?: string };
type AnthropicResponse = {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: {
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens_details?: { thinking_tokens?: number };
  };
};

async function callAnthropic(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; json: AnthropicResponse }> {
  const res = await fetch(`${ANTHROPIC_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { ok: res.ok, status: res.status, json };
}

type AnthropicVerifyResult = {
  provider: "anthropic";
  modelRequested: string;
  ok: boolean;
  error: Record<string, unknown> | null;
  item1_toolCalling: { pass: boolean; toolUseCount: number; evidence: unknown };
  item2_toolResultMerge: { pass: boolean; toolUseCount: number; secondStopReason: string | null; evidence: unknown };
  item3_usageFieldNames: { firstRoundKeys: string[]; secondRoundKeys: string[]; evidence: unknown };
  item4_effortDirection: {
    pass: boolean;
    lowThinkingTokens: number | null;
    maxThinkingTokens: number | null;
    lowUsage: unknown;
    maxUsage: unknown;
  };
  item5_cacheControl: {
    pass: boolean;
    firstCacheCreation: number | null;
    secondCacheRead: number | null;
    firstUsage: unknown;
    secondUsage: unknown;
  };
  item6_enabledThinkingRejected: { pass: boolean; status: number | null; evidence: unknown };
};

async function verifyAnthropic(): Promise<AnthropicVerifyResult> {
  const apiKey = process.env[ANTHROPIC_API_KEY_ENV];
  const model = ANTHROPIC_MODEL;
  const result: AnthropicVerifyResult = {
    provider: "anthropic",
    modelRequested: model,
    ok: false,
    error: null,
    item1_toolCalling: { pass: false, toolUseCount: 0, evidence: null },
    item2_toolResultMerge: { pass: false, toolUseCount: 0, secondStopReason: null, evidence: null },
    item3_usageFieldNames: { firstRoundKeys: [], secondRoundKeys: [], evidence: null },
    item4_effortDirection: { pass: false, lowThinkingTokens: null, maxThinkingTokens: null, lowUsage: null, maxUsage: null },
    item5_cacheControl: { pass: false, firstCacheCreation: null, secondCacheRead: null, firstUsage: null, secondUsage: null },
    item6_enabledThinkingRejected: { pass: false, status: null, evidence: null },
  };

  if (!apiKey) {
    result.error = { message: `缺少環境變數 ${ANTHROPIC_API_KEY_ENV}，跳過` };
    return result;
  }

  try {
    // 項目 1＋2：tool calling ＋ tool_result 合併形態。要求模型在同一回合內併發呼叫兩次
    // read_file，取得兩個 tool_use block 後，用「一則 user message 內含兩個 tool_result
    // block」續接，驗證 API 是否接受且模型正確續接（規格十一第 1、2 項）。
    const toolPrompt =
      '請同時呼叫兩次 read_file 工具：一次讀取路徑 "package.json"，一次讀取路徑 "tsconfig.json"。' +
      "務必在同一個回合內一次發出兩個工具呼叫，不要先讀一個、等結果回來後才讀下一個。";
    const first = await callAnthropic(apiKey, {
      model,
      max_tokens: 1024,
      tools: [ANTHROPIC_READ_FILE_TOOL],
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      messages: [{ role: "user", content: toolPrompt }],
    });
    if (!first.ok) {
      result.error = { step: "item1+2 first call", status: first.status, body: first.json };
      return result;
    }
    const firstContent: AnthropicContentBlock[] = first.json.content ?? [];
    const toolUseBlocks = firstContent.filter((b) => b.type === "tool_use");
    result.item1_toolCalling = { pass: toolUseBlocks.length > 0, toolUseCount: toolUseBlocks.length, evidence: firstContent };
    result.item3_usageFieldNames.firstRoundKeys = Object.keys(first.json.usage ?? {});

    if (toolUseBlocks.length > 0) {
      const toolResultContent = toolUseBlocks.map((b) => ({
        type: "tool_result",
        tool_use_id: b.id,
        content: FAKE_TOOL_RESULT,
      }));
      const second = await callAnthropic(apiKey, {
        model,
        max_tokens: 1024,
        tools: [ANTHROPIC_READ_FILE_TOOL],
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
        messages: [
          { role: "user", content: toolPrompt },
          { role: "assistant", content: firstContent },
          // 規格五：多筆 tool_result 併入同一則 user message，不逐筆送出。
          { role: "user", content: toolResultContent },
        ],
      });
      if (!second.ok) {
        result.item2_toolResultMerge = {
          pass: false,
          toolUseCount: toolUseBlocks.length,
          secondStopReason: null,
          evidence: { status: second.status, body: second.json },
        };
      } else {
        result.item2_toolResultMerge = {
          pass: toolUseBlocks.length >= 2 && second.json.stop_reason != null,
          toolUseCount: toolUseBlocks.length,
          secondStopReason: second.json.stop_reason ?? null,
          evidence: second.json.content,
        };
        result.item3_usageFieldNames.secondRoundKeys = Object.keys(second.json.usage ?? {});
      }
    }

    // 項目 4：effort 真的生效——同一 prompt 跑 low 與 max，比對
    // usage.output_tokens_details.thinking_tokens 是否朝預期方向變化（不是「沒報錯」）。
    const effortPrompt =
      "請逐步、詳細地分析並解出以下問題，並在最後檢查你的計算：一列火車先以 80 公里/小時行駛 2.5 小時，" +
      "接著停靠 15 分鐘，再以 120 公里/小時行駛 1.75 小時。請計算總行駛距離與總耗時（含停靠），並列出完整計算過程。";
    const [lowRes, maxRes] = await Promise.all([
      callAnthropic(apiKey, {
        model,
        max_tokens: 4096,
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
        messages: [{ role: "user", content: effortPrompt }],
      }),
      callAnthropic(apiKey, {
        model,
        max_tokens: 4096,
        thinking: { type: "adaptive" },
        output_config: { effort: "max" },
        messages: [{ role: "user", content: effortPrompt }],
      }),
    ]);
    if (lowRes.ok && maxRes.ok) {
      const lowThinking = lowRes.json.usage?.output_tokens_details?.thinking_tokens ?? 0;
      const maxThinking = maxRes.json.usage?.output_tokens_details?.thinking_tokens ?? 0;
      result.item4_effortDirection = {
        pass: maxThinking > lowThinking,
        lowThinkingTokens: lowThinking,
        maxThinkingTokens: maxThinking,
        lowUsage: lowRes.json.usage,
        maxUsage: maxRes.json.usage,
      };
    } else {
      result.item4_effortDirection.lowUsage = lowRes.ok ? lowRes.json.usage : { status: lowRes.status, body: lowRes.json };
      result.item4_effortDirection.maxUsage = maxRes.ok ? maxRes.json.usage : { status: maxRes.status, body: maxRes.json };
    }

    // 項目 5：頂層 cache_control 真的生效——連續兩次送出相同前綴，第二次的
    // cache_read_input_tokens 須 > 0。前綴須超過該模型最低可快取 token 數（Sonnet 5 / Opus
    // 4.8 為 1,024 token），故用重複段落墊長，而非精簡文字。
    const longPrefixParagraph =
      "以下是用於驗證 prompt caching 是否生效的填充文字，內容本身沒有語意重要性，僅用於墊高 token 數。" +
      "Anthropic 的 prompt caching 機制要求前綴長度超過模型的最低可快取門檻才會建立快取分段，" +
      "本文字重複多次以確保超過門檻。";
    const longPrefix = Array.from({ length: 40 }, (_, i) => `${i + 1}. ${longPrefixParagraph}`).join("\n");
    const cacheReqBody = {
      model,
      max_tokens: 64,
      cache_control: { type: "ephemeral" },
      system: longPrefix,
      messages: [{ role: "user", content: "請用一句話回答：這份文字在講什麼？" }],
    };
    const cacheFirst = await callAnthropic(apiKey, cacheReqBody);
    const cacheSecond = await callAnthropic(apiKey, cacheReqBody);
    if (cacheFirst.ok && cacheSecond.ok) {
      result.item5_cacheControl = {
        pass: (cacheSecond.json.usage?.cache_read_input_tokens ?? 0) > 0,
        firstCacheCreation: cacheFirst.json.usage?.cache_creation_input_tokens ?? null,
        secondCacheRead: cacheSecond.json.usage?.cache_read_input_tokens ?? null,
        firstUsage: cacheFirst.json.usage,
        secondUsage: cacheSecond.json.usage,
      };
    } else {
      result.item5_cacheControl.firstUsage = cacheFirst.ok ? cacheFirst.json.usage : { status: cacheFirst.status, body: cacheFirst.json };
      result.item5_cacheControl.secondUsage = cacheSecond.ok ? cacheSecond.json.usage : { status: cacheSecond.status, body: cacheSecond.json };
    }

    // 項目 6：負面驗證——確認 thinking:{type:"enabled"} 在此模型上確實 400（規格二），
    // 而不是「碰巧沒踩到」。
    const enabledThinking = await callAnthropic(apiKey, {
      model,
      max_tokens: 1024,
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [{ role: "user", content: "1+1 等於多少？" }],
    });
    result.item6_enabledThinkingRejected = {
      pass: enabledThinking.status === 400,
      status: enabledThinking.status,
      evidence: enabledThinking.json,
    };

    result.ok = true;
    return result;
  } catch (err) {
    result.error = describeError(err);
    return result;
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const outDir = "tmp/verify";
  await mkdir(outDir, { recursive: true });

  const results: ProviderResult[] = [];

  for (const config of RESPONSES_PROVIDERS) {
    console.log(`\n=== ${config.name} (/v1/responses) ===`);
    const result = await verifyResponsesProvider(config);
    results.push(result);
    console.log(maskString(JSON.stringify(result, null, 2)));
  }

  console.log(`\n=== ${GEMINI_CONFIG.name} (native generateContent) ===`);
  const geminiResult = await verifyGemini(GEMINI_CONFIG);
  results.push(geminiResult);
  console.log(maskString(JSON.stringify(geminiResult, null, 2)));

  const summaryPath = `${outDir}/summary.json`;
  await writeFile(summaryPath, maskString(JSON.stringify(results, null, 2)), "utf8");
  console.log(`\n完整結果（已遮蔽）已寫入 ${summaryPath}`);

  console.log(`\n=== anthropic (native Messages API，plan_dispatch_v2.7.md §29 規格十一) ===`);
  const anthropicResult = await verifyAnthropic();
  console.log(maskString(JSON.stringify(anthropicResult, null, 2)));
  const anthropicSummaryPath = `${outDir}/anthropic-summary.json`;
  await writeFile(anthropicSummaryPath, maskString(JSON.stringify(anthropicResult, null, 2)), "utf8");
  console.log(`\n完整結果（已遮蔽）已寫入 ${anthropicSummaryPath}`);

  const anthropicAllPass =
    anthropicResult.item1_toolCalling.pass &&
    anthropicResult.item2_toolResultMerge.pass &&
    anthropicResult.item4_effortDirection.pass &&
    anthropicResult.item5_cacheControl.pass &&
    anthropicResult.item6_enabledThinkingRejected.pass;
  console.log(`\nanthropic 六項驗證：${anthropicAllPass ? "通過（項目 3 為欄位名清單，需人工核對）" : "未全數通過，見上方各項 pass 欄位"}`);
  if (!anthropicAllPass) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(maskString(String(err)));
  process.exitCode = 1;
});
