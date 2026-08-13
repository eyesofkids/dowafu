// plan_dispatch_v1.4.md §7/§8：gemini-native adapter，原生 generateContent，不套 OpenAI
// 相容殼（decision「介面策略」；issue_log_v1.md 2026-08-05「作一個專門給 Gemini」裁示）。
// 金鑰走 x-goog-api-key header，不進 URL query string（§18）。
//
// assistant turn 的 raw 就是 candidate.content（{role:"model", parts:[...]}）整個物件，
// 續接時原樣放回 contents（§8）——gemini-3.x 系列的 thoughtSignature 掛在 part 上，
// 隨 raw 一起帶回，不需另闢欄位承接。

import type { Adapter, Conversation, Lang, SendOptions, SendResult, ToolCall, Turn } from "../types.js";
import { normalizeFinishReason, normalizeGeminiUsage } from "../usage.js";
import { ProviderHttpError } from "../mask.js";
import { checkRawObjectIntegrity } from "../raw-integrity.js";
import { readFileToolDescription } from "./read-file-tool-description.js";

function buildGeminiTool(lang: Lang) {
  return {
    functionDeclarations: [
      {
        name: "read_file",
        description: readFileToolDescription(lang),
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
  };
}

type GeminiPart = {
  text?: string;
  functionCall?: { name: string; args: unknown; id?: string };
  functionResponse?: { name: string; response: unknown };
  thoughtSignature?: string;
};

export type GeminiContent = { role: string; parts: GeminiPart[] };

export type GeminiAdapterConfig = {
  apiKey: string;
  baseURL: string; // 例如 https://generativelanguage.googleapis.com/v1beta
  lang: Lang; // T5：read_file 工具 description 依 spoke.lang 選用（C 類雙語常數）
};

function turnToContent(turn: Turn): GeminiContent {
  if (turn.role === "user") {
    return { role: "user", parts: [{ text: turn.text }] };
  }
  if (turn.role === "tool") {
    // functionResponse 以 name 對應，不需要 call id（實測確認，見 issue_log）
    let responseObj: unknown;
    try {
      responseObj = JSON.parse(turn.result);
    } catch {
      responseObj = { result: turn.result };
    }
    return {
      role: "user",
      parts: [{ functionResponse: { name: turn.callId, response: responseObj } }],
    };
  }
  // assistant：raw 就是上一輪 candidate.content，原樣放回
  return turn.raw as GeminiContent;
}

// plan_dispatch_v1.8.md §5「reasoning.style 的三種轉換」（實測確認）：位置與大小寫都關鍵——
// 頂層 thinking_level 會 400；巢狀內 snake_case（thinking_level）會 200 但 Google 對未知
// 欄位靜默忽略、不生效。正確路徑是 generationConfig.thinkingConfig.thinkingLevel（camelCase）。
function buildReasoningParams(effort: string | undefined): Record<string, unknown> {
  if (!effort) return {};
  return { generationConfig: { thinkingConfig: { thinkingLevel: effort } } };
}

// 純函式：組出實際會送出的 request body，並執行 §8 的 raw 完整性自我檢查（違反即拋
// RawIntegrityError，不需打 API 就能測試——見 raw-integrity.test.ts）。
export function buildGeminiRequest(
  conv: Conversation,
  opts: SendOptions,
  lang: Lang,
): { contents: GeminiContent[]; body: Record<string, unknown> } {
  const contents: GeminiContent[] = conv.turns.map(turnToContent);
  checkRawObjectIntegrity(conv, contents, lang);

  const body: Record<string, unknown> = {
    contents,
    system_instruction: { parts: [{ text: conv.systemPrompt }] },
    ...(opts.enableTools === false ? {} : { tools: [buildGeminiTool(lang)] }),
    ...buildReasoningParams(opts.effort),
  };
  return { contents, body };
}

export function createGeminiAdapter(config: GeminiAdapterConfig): Adapter {
  return {
    async send(conv: Conversation, opts: SendOptions): Promise<SendResult> {
      const { body } = buildGeminiRequest(conv, opts, config.lang);

      const res = await fetch(`${config.baseURL}/models/${opts.model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
      const responseBody = await res.json();
      if (!res.ok) {
        throw new ProviderHttpError(
          `Gemini native API ${res.status}`,
          res.status,
          Object.fromEntries(res.headers.entries()),
          responseBody,
          body,
        );
      }

      const candidate = responseBody.candidates?.[0];
      const parts: GeminiPart[] = candidate?.content?.parts ?? [];
      const callParts = parts.filter((p) => p.functionCall);

      const toolCalls: ToolCall[] = callParts.map((p, index) => ({
        id: p.functionCall?.id ?? `gemini-call-${index}`,
        name: p.functionCall!.name,
        args: (p.functionCall!.args as Record<string, unknown>) ?? {},
      }));

      const text = parts
        .filter((p) => typeof p.text === "string")
        .map((p) => p.text)
        .join("");

      const { finishReason, finishReasonRaw } = normalizeFinishReason(candidate?.finishReason ?? null);

      return {
        turn: {
          role: "assistant",
          raw: candidate?.content ?? { role: "model", parts: [] },
          toolCalls,
        },
        usage: normalizeGeminiUsage(responseBody.usageMetadata),
        usageRaw: responseBody.usageMetadata ?? null,
        meta: {
          modelReturned: responseBody.modelVersion ?? null,
          finishReason,
          finishReasonRaw,
          requestId: responseBody.responseId ?? null,
          store: "n/a", // §6：generateContent 無此參數
          text: toolCalls.length === 0 ? text || null : null,
        },
        request: body,
        response: responseBody,
      };
    },
  };
}
