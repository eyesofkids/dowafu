// plan_dispatch_v1.4.md §7/§8：openai／deepseek 共用的 `responses` adapter。
// 全面 stateless（§6）：每輪把 conv.turns 整段轉成 input 陣列重送，不用
// previous_response_id。assistant turn 續接用 raw（該輪 response.output 整包），
// 不用 toolCalls 重建——這是 v1.3 犯錯、v1.4 §8 明訂修正的地方。

import OpenAI from "openai";
import type {
  Adapter,
  Conversation,
  ReasoningConfig,
  SendOptions,
  SendResult,
  ToolCall,
  Turn,
} from "../types.js";
import { normalizeFinishReason, normalizeResponsesUsage } from "../usage.js";
import { ProviderHttpError } from "../mask.js";
import { checkRawArrayIntegrity } from "../raw-integrity.js";

const READ_FILE_TOOL: OpenAI.Responses.FunctionTool = {
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

export type ResponsesAdapterConfig = {
  baseURL: string;
  apiKey: string;
  store: false | null; // §5：null 代表該 API 無此參數（v1 的 responses provider 恆為 false）
  reasoning: ReasoningConfig;
};

// plan_dispatch_v1.8.md §5「reasoning.style 的三種轉換」（實測確認，v1.7 兩處填錯已修正）：
// deepseek 正確路徑是 output_config.effort，不是 chat/completions 章節的
// thinking/reasoning_effort——後者對 /v1/responses 端點回顯欄位但靜默不生效
// （issue_log_v1.md 2026-08-06）。
function buildReasoningParams(
  style: ReasoningConfig["style"],
  effort: string | undefined,
): Record<string, unknown> {
  if (!effort) return {}; // §4：留白則不送任何 reasoning 參數（v1 起 validate.ts 已解析為 default，實務上不會是 undefined）
  if (style === "openai") return { reasoning: { effort } };
  if (style === "deepseek") return { output_config: { effort } };
  throw new Error(`responses adapter 不支援 reasoning.style=${style}`);
}

function turnToInputItems(turn: Turn): OpenAI.Responses.ResponseInputItem[] {
  if (turn.role === "user") {
    return [{ role: "user", content: [{ type: "input_text", text: turn.text }] }];
  }
  if (turn.role === "tool") {
    return [{ type: "function_call_output", call_id: turn.callId, output: turn.result }];
  }
  // assistant：raw 是上一輪的完整 response.output 陣列，原樣展開塞回（§8）
  return turn.raw as OpenAI.Responses.ResponseInputItem[];
}

// 純函式：組出實際會送出的請求，並執行 §8 的 raw 完整性自我檢查（違反即拋
// RawIntegrityError，不需打 API 就能測試——見 raw-integrity.test.ts）。
export function buildResponsesRequest(
  conv: Conversation,
  opts: SendOptions,
  config: ResponsesAdapterConfig,
): OpenAI.Responses.ResponseCreateParamsNonStreaming {
  const input: OpenAI.Responses.ResponseInputItem[] = conv.turns.flatMap(turnToInputItems);
  checkRawArrayIntegrity(conv, input);

  return {
    model: opts.model,
    instructions: conv.systemPrompt,
    input,
    ...(opts.enableTools === false ? {} : { tools: [READ_FILE_TOOL] }),
    ...(config.store === false ? { store: false as const } : {}),
    include: ["reasoning.encrypted_content"],
    ...buildReasoningParams(config.reasoning.style, opts.effort),
  };
}

export function createResponsesAdapter(config: ResponsesAdapterConfig): Adapter {
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });

  return {
    async send(conv: Conversation, opts: SendOptions): Promise<SendResult> {
      const params = buildResponsesRequest(conv, opts, config);

      let response: OpenAI.Responses.Response;
      try {
        response = await client.responses.create(params, { signal: opts.signal });
      } catch (err) {
        if (err && typeof err === "object" && "status" in err) {
          const anyErr = err as { status?: number; headers?: unknown; error?: unknown; message?: string };
          throw new ProviderHttpError(
            anyErr.message ?? "responses adapter 呼叫失敗",
            anyErr.status ?? 0,
            (anyErr.headers as Record<string, string>) ?? {},
            anyErr.error,
            params,
          );
        }
        throw err;
      }

      const functionCalls = response.output.filter(
        (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call",
      );
      const toolCalls: ToolCall[] = functionCalls.map((call) => ({
        id: call.call_id,
        name: call.name,
        args: safeParseArgs(call.arguments),
      }));

      const messageItem = response.output.find(
        (item): item is OpenAI.Responses.ResponseOutputMessage => item.type === "message",
      );
      const text =
        messageItem?.content
          .filter((c): c is OpenAI.Responses.ResponseOutputText => c.type === "output_text")
          .map((c) => c.text)
          .join("") ?? null;

      const { finishReason, finishReasonRaw } = normalizeFinishReason(response.status);

      return {
        turn: { role: "assistant", raw: response.output, toolCalls },
        usage: normalizeResponsesUsage(response.usage),
        usageRaw: response.usage ?? null,
        meta: {
          modelReturned: response.model ?? null,
          finishReason,
          finishReasonRaw,
          requestId: response.id ?? null,
          store: config.store === false ? "false" : "n/a",
          text: functionCalls.length === 0 ? text : null,
        },
        request: params,
        response,
      };
    },
  };
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}
