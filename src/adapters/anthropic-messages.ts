// plan_dispatch_v2.7.md §29：anthropic-messages adapter（Claude Opus 5／Sonnet 5）。
// 原生 Messages API，不套 OpenAI 相容殼——responses adapter 的具體型別（client.responses.create、
// function_call_output、response.output）與這裡的 wire format 完全不同，即使 reasoning.style
// 的 JSON 片段長得像 deepseek 的 output_config.effort（見規格二），也不得重用 responses adapter：
// 那條路徑走 OpenAI SDK 與 /v1/responses 端點，端點、headers、訊息格式全不對。
//
// assistant turn 的 raw 是整個 {role:"assistant", content:[...blocks]} message 物件，續接時
// 原樣放回 messages 陣列——與 gemini-native 同形，用 checkRawObjectIntegrity（不是
// checkRawArrayIntegrity）。§29 規格六：Opus 4.5／4.6 以上模型會把前輪 thinking block
// 併入 input 計費，且 manual 模式下最後一輪 assistant turn 須以 thinking block 開頭——
// content 陣列必須原封不動塞回，不得過濾掉 thinking block。
//
// §29 規格五：Anthropic 的 tool_result block 放在 user role 的 message 裡，且多筆結果應併在
// 同一則 message——runner.ts 每個 tool 呼叫各自 push 一個 { role:"tool" } turn，故這裡的轉換
// 需要前瞻（look-ahead）把連續的 tool turn 合併成一則 user message，responses adapter 的
// turnToInputItems 那種一對多純映射在此不適用（見 turnsToMessages）。
//
// §29 規格十一：本檔的所有形態已用 scripts/verify-providers.ts 對真實 API 逐項實測
// 確認過（tool calling、tool_result 合併、usage 欄位名、effort 生效方向、cache_control
// 生效、thinking.type:"enabled" 確實 400），結果見 facts_dispatch.md。

import type { Adapter, Conversation, Lang, ReasoningConfig, SendOptions, SendResult, ToolCall, Turn } from "../types.js";
import { normalizeAnthropicUsage, normalizeFinishReason } from "../usage.js";
import { ProviderHttpError } from "../mask.js";
import { checkRawObjectIntegrity } from "../raw-integrity.js";
import { readFileToolDescription } from "./read-file-tool-description.js";

const ANTHROPIC_VERSION = "2023-06-01";

// §29 規格四：max_tokens 是 Anthropic 專屬必要參數，SendOptions 沒有這個概念（openai／gemini
// 都不需要）。寫死在 adapter，不提升到 SendOptions——那會逼另外兩個 adapter 處理用不到的欄位。
// 初始值推導見規格四：十次派工單支最高 40,970 output token，32k 有 20% 餘裕；本版預設 effort
// 不會用到官方建議 64k 起跳的 xhigh／max。撞到 stop_reason:"max_tokens" 再調，不在此臆測。
const ANTHROPIC_MAX_TOKENS = 32768;

function buildReadFileTool(lang: Lang) {
  return {
    name: "read_file",
    description: readFileToolDescription(lang),
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  };
}

type AnthropicContentBlock = Record<string, unknown> & { type: string };

export type AnthropicMessage = { role: "user" | "assistant"; content: string | AnthropicContentBlock[] };

export type AnthropicAdapterConfig = {
  baseURL: string;
  apiKey: string;
  reasoning: ReasoningConfig;
  lang: Lang; // T5：read_file 工具 description 依 spoke.lang 選用（C 類雙語常數）
};

// §29 規格二：thinking.type:"enabled" 在 Opus 5／Sonnet 5 會 400（實測確認，見
// facts_dispatch.md）。正確路徑是 adaptive thinking ＋ output_config.effort，兩者一起送——
// 即使 output_config.effort 的 JSON 片段與 deepseek 的 reasoning.style 完全相同，這是巧合
// 不是可重用的理由（deepseek 走 responses adapter／OpenAI SDK，端點與訊息格式全不同）。
function buildReasoningParams(style: ReasoningConfig["style"], effort: string | undefined): Record<string, unknown> {
  if (!effort) return {}; // §4：留白則不送任何 reasoning 參數（validate.ts 已解析為 default，實務上不會是 undefined）
  if (style === "anthropic") return { thinking: { type: "adaptive" }, output_config: { effort } };
  // T7a〈D. 全域中文字串最終覆核〉：providers.json 的 schema 已限定 reasoning.style 只能是
  // "openai"／"deepseek"／"gemini"／"anthropic"／null（見 providers.ts 的 parseReasoning），
  // 此分支理論上不可達，同 raw-integrity.ts 的實作缺陷斷言。明確決定維持中文不動，不搬進
  // messages.ts——多語系對一段不可達的防禦性文字沒有實質效益。
  throw new Error(`anthropic-messages adapter 不支援 reasoning.style=${style}`);
}

// §29 規格五：把 conv.turns 轉成 Anthropic 的 messages 陣列。tool turn 需要前瞻合併——
// runner.ts 對同一輪的每個 tool call 各自 push 一個 { role:"tool" } turn，連續的多個 tool
// turn 必須合併成一則 user message、內含多個 tool_result block，不能逐筆送出（逐筆送出會
// 產生連續兩則 user message，Anthropic 不接受這種形態）。
function turnsToMessages(turns: readonly Turn[]): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  let i = 0;
  while (i < turns.length) {
    const turn = turns[i];
    if (turn.role === "user") {
      messages.push({ role: "user", content: turn.text });
      i++;
      continue;
    }
    if (turn.role === "assistant") {
      // raw 是上一輪原樣的 {role:"assistant", content:[...blocks]} 物件，原樣放回（§8／規格六）
      messages.push(turn.raw as AnthropicMessage);
      i++;
      continue;
    }
    // turn.role === "tool"：吃掉所有連續的 tool turn，併成一則 user message
    const toolResults: AnthropicContentBlock[] = [];
    while (i < turns.length && turns[i].role === "tool") {
      const toolTurn = turns[i] as Extract<Turn, { role: "tool" }>;
      toolResults.push({ type: "tool_result", tool_use_id: toolTurn.callId, content: toolTurn.result });
      i++;
    }
    messages.push({ role: "user", content: toolResults });
  }
  return messages;
}

// 純函式：組出實際會送出的請求，並執行 §8 的 raw 完整性自我檢查（違反即拋 RawIntegrityError，
// 不需打 API 就能測試——見 anthropic-messages.test.ts）。
export function buildAnthropicRequest(
  conv: Conversation,
  opts: SendOptions,
  config: Pick<AnthropicAdapterConfig, "reasoning" | "lang">,
): Record<string, unknown> {
  const messages = turnsToMessages(conv.turns);
  checkRawObjectIntegrity(conv, messages, config.lang);

  return {
    model: opts.model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    system: conv.systemPrompt,
    messages,
    // §29 規格八：top-level 自動快取，由 API 自行管理斷點位置並隨對話推進。低於該模型最低
    // 可快取 token 數時 API 靜默不快取、不報錯，故此欄位可無條件加，不需前置估算。
    cache_control: { type: "ephemeral" },
    ...(opts.enableTools === false ? {} : { tools: [buildReadFileTool(config.lang)] }),
    ...buildReasoningParams(config.reasoning.style, opts.effort),
  };
}

export function createAnthropicAdapter(config: AnthropicAdapterConfig): Adapter {
  return {
    async send(conv: Conversation, opts: SendOptions): Promise<SendResult> {
      const body = buildAnthropicRequest(conv, opts, config);

      const res = await fetch(`${config.baseURL}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": config.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      const responseBody = await res.json();
      if (!res.ok) {
        throw new ProviderHttpError(
          `Anthropic Messages API ${res.status}`,
          res.status,
          Object.fromEntries(res.headers.entries()),
          responseBody,
          body,
        );
      }

      const content: AnthropicContentBlock[] = responseBody.content ?? [];
      const toolUseBlocks = content.filter((b) => b.type === "tool_use");
      const toolCalls: ToolCall[] = toolUseBlocks.map((b) => ({
        id: b.id as string,
        name: b.name as string,
        args: (b.input as Record<string, unknown>) ?? {},
      }));

      const text = content
        .filter((b) => b.type === "text")
        .map((b) => b.text as string)
        .join("");

      const { finishReason, finishReasonRaw } = normalizeFinishReason(responseBody.stop_reason ?? null);

      return {
        turn: { role: "assistant", raw: { role: "assistant", content }, toolCalls },
        usage: normalizeAnthropicUsage(responseBody.usage),
        usageRaw: responseBody.usage ?? null,
        meta: {
          modelReturned: responseBody.model ?? null,
          finishReason,
          finishReasonRaw,
          requestId: responseBody.id ?? null,
          store: "n/a", // §6：Messages API 無 store 概念（規格九）
          text: toolCalls.length === 0 ? text || null : null,
        },
        request: body,
        response: responseBody,
      };
    },
  };
}
