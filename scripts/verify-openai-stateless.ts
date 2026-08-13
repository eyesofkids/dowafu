// _docs/dispatch/plan_dispatch_v1.4.md §20「第二階段的第一項驗證」：
// openai `/v1/responses` 在 `store:false`（全面 stateless，§6）下，reasoning item 的
// `encrypted_content` 隨整段歷史帶回，多輪 tool-use 是否正常。不通則 §6 的 openai
// 路徑要改設計，不是改實作——這是本輪的第一步，先驗證再往下寫 adapter。
//
// 額外記錄（§20 要求）：
// 1. 正常路徑：store:false + include reasoning.encrypted_content，多輪（3 輪以上）
//    tool-use 是否正常完成。
// 2. 失敗路徑：不帶 include（reasoning item 無 encrypted_content）時續接會發生什麼、
//    錯誤訊息長什麼樣（供 §13 診斷用）。
// 3. `reasoning.context` 未設定時的實際行為（facts 記載 GPT-5.6 預設 all_turns）。
//
// 比照第一階段做法：獨立最小腳本，不搭框架，錯誤遮蔽從第一支腳本就套用（§12）。

// plan_dispatch_v1.11.md §26：金鑰只該有一個位置——與 CLI 同一條載入路徑
// （$DISPATCH_HOME/.env，ambient 優先），不讀 cwd 的 .env。
import { loadDispatchEnv, resolveDispatchHome } from "../src/dispatch-home.js";
import OpenAI from "openai";
import { writeFile, mkdir } from "node:fs/promises";

const dispatchHome = resolveDispatchHome();
if (dispatchHome !== null) loadDispatchEnv(dispatchHome);

const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const FAKE_PACKAGE_JSON_RESULT = '{"name":"dowafu"}';
const FAKE_TSCONFIG_RESULT = '{"compilerOptions":{"module":"NodeNext"}}';

// 強迫至少兩次連續 tool call，逼出 3 輪以上的續接（round1 呼叫 read_file(package.json)
// → round2 呼叫 read_file(tsconfig.json) → round3 給最終答案），比單一 tool call 更貼近
// 真實 spoke 多輪讀檔的情境。
const USER_PROMPT =
  '請依序執行：先呼叫 read_file 讀取 "package.json"，再呼叫 read_file 讀取 "tsconfig.json"。' +
  '兩個都讀完後，用一句話分別告訴我 package.json 的 "name" 欄位與 tsconfig.json 的 ' +
  '"compilerOptions.module" 欄位。';

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

// ---------------------------------------------------------------------------
// §12：API key 不得出現在任何落檔、stdout 或錯誤訊息中。
// ---------------------------------------------------------------------------

const apiKey = process.env.OPENAI_API_KEY;
const secretValues = [apiKey].filter((v): v is string => Boolean(v && v.length > 0));

function maskString(input: string): string {
  let out = input;
  for (const secret of secretValues) {
    out = out.split(secret).join("***REDACTED***");
  }
  out = out.replace(/sk-[A-Za-z0-9]{10,}/g, "***REDACTED***");
  return out;
}

const REDACTED_HEADER_KEYS = new Set(["authorization", "x-api-key", "api-key"]);

function maskHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    out[key] = REDACTED_HEADER_KEYS.has(key.toLowerCase())
      ? "***REDACTED***"
      : maskString(String(value));
  }
  return out;
}

// 刻意不對 error 物件做 JSON.stringify(error)（§12 明文警告）。白名單挑欄位、逐欄遮蔽。
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
    return {
      status,
      is429: status === 429,
      retryAfterHeader: headers?.["retry-after"] ?? headers?.["Retry-After"] ?? null,
      message,
      errorBody,
      headers,
    };
  }
  return { message: maskString(String(err)) };
}

function maskDeep(value: unknown): unknown {
  if (typeof value === "string") return maskString(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskDeep(v)]),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------

if (!apiKey) {
  console.error("缺少環境變數 OPENAI_API_KEY");
  process.exit(1);
}

const client = new OpenAI({ apiKey });

function extractFunctionCalls(
  output: OpenAI.Responses.ResponseOutputItem[],
): OpenAI.Responses.ResponseFunctionToolCall[] {
  return output.filter(
    (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call",
  );
}

function fakeResultFor(path: string): string {
  if (path.includes("tsconfig")) return FAKE_TSCONFIG_RESULT;
  return FAKE_PACKAGE_JSON_RESULT;
}

function describeReasoningItems(output: OpenAI.Responses.ResponseOutputItem[]) {
  return output
    .filter((item): item is OpenAI.Responses.ResponseReasoningItem => item.type === "reasoning")
    .map((item) => ({
      id: item.id,
      hasEncryptedContent: typeof item.encrypted_content === "string",
      encryptedContentLength: item.encrypted_content?.length ?? 0,
      summaryItemCount: item.summary.length,
    }));
}

// ---------------------------------------------------------------------------
// 測試 A：正常路徑——store:false + include reasoning.encrypted_content，多輪續接
// ---------------------------------------------------------------------------

async function testA_normalStatelessMultiRound() {
  console.log("\n=== 測試 A：store:false + include encrypted_content，多輪續接 ===");

  const rounds: Record<string, unknown>[] = [];
  let history: OpenAI.Responses.ResponseInputItem[] = [
    { role: "user", content: [{ type: "input_text", text: USER_PROMPT }] },
  ];
  const reasoningContextObserved: unknown[] = [];

  const MAX_ROUNDS = 6;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let response: OpenAI.Responses.Response;
    try {
      response = await client.responses.create({
        model: MODEL,
        input: history,
        tools: [READ_FILE_TOOL],
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoning: { effort: "medium" },
        // reasoning.context 刻意不設，觀察未設定時的實際行為（facts 記載預設 all_turns）
      } as OpenAI.Responses.ResponseCreateParamsNonStreaming);
    } catch (err) {
      const errorInfo = describeError(err);
      rounds.push({ round, error: errorInfo });
      console.log(`round ${round} 呼叫失敗:`, maskDeep(errorInfo));
      return { rounds, reasoningContextObserved, ok: false };
    }

    reasoningContextObserved.push(response.reasoning ?? null);

    const functionCalls = extractFunctionCalls(response.output);
    const reasoningInfo = describeReasoningItems(response.output);
    rounds.push({
      round,
      modelReturned: response.model,
      status: response.status,
      usage: response.usage,
      hasToolCalls: functionCalls.length > 0,
      toolCallNames: functionCalls.map((c) => c.name + ":" + JSON.parse(c.arguments).path),
      reasoning: response.reasoning,
      reasoningItems: reasoningInfo,
    });
    console.log(
      `round ${round}: status=${response.status} toolCalls=${functionCalls.length} ` +
        `reasoningItems=${JSON.stringify(reasoningInfo)} usage=${JSON.stringify(response.usage)}`,
    );

    if (functionCalls.length === 0) {
      // 沒有 tool call：模型給了最終答案，正常結束
      return { rounds, reasoningContextObserved, ok: true, finalOutput: response.output };
    }

    // 整段歷史重送（§6 全面 stateless）：原樣附加這一輪的完整 output（含 reasoning item），
    // 不解構重組（§8 的「raw 原樣保留」原則，本腳本先手動驗證這個前提）。
    history = [
      ...history,
      ...(response.output as unknown as OpenAI.Responses.ResponseInputItem[]),
      ...functionCalls.map(
        (call): OpenAI.Responses.ResponseInputItem.FunctionCallOutput => ({
          type: "function_call_output",
          call_id: call.call_id,
          output: fakeResultFor(JSON.parse(call.arguments).path),
        }),
      ),
    ];
  }

  return { rounds, reasoningContextObserved, ok: false, error: "超過 MAX_ROUNDS 仍未結束" };
}

// ---------------------------------------------------------------------------
// 測試 B：失敗路徑——round 1 不帶 include，reasoning item 無 encrypted_content，
// 再嘗試續接，記錄實際錯誤訊息（供 §13 診斷用）。
// ---------------------------------------------------------------------------

async function testB_missingEncryptedContent() {
  console.log("\n=== 測試 B：round 1 不帶 include，觀察續接失敗訊息 ===");

  const history: OpenAI.Responses.ResponseInputItem[] = [
    { role: "user", content: [{ type: "input_text", text: USER_PROMPT }] },
  ];

  const first = await client.responses.create({
    model: MODEL,
    input: history,
    tools: [READ_FILE_TOOL],
    store: false,
    // 刻意不帶 include：reasoning item 會存在但 encrypted_content 為 null/缺失
    reasoning: { effort: "medium" },
  } as OpenAI.Responses.ResponseCreateParamsNonStreaming);

  const reasoningInfo = describeReasoningItems(first.output);
  console.log(`round 1（無 include）reasoningItems=${JSON.stringify(reasoningInfo)}`);

  const functionCalls = extractFunctionCalls(first.output);
  if (functionCalls.length === 0) {
    return {
      round1ReasoningItems: reasoningInfo,
      note: "round 1 未觸發 tool call，無法測試續接，改變 prompt 或視為不適用",
    };
  }

  const nextHistory: OpenAI.Responses.ResponseInputItem[] = [
    ...history,
    ...(first.output as unknown as OpenAI.Responses.ResponseInputItem[]),
    ...functionCalls.map(
      (call): OpenAI.Responses.ResponseInputItem.FunctionCallOutput => ({
        type: "function_call_output",
        call_id: call.call_id,
        output: fakeResultFor(JSON.parse(call.arguments).path),
      }),
    ),
  ];

  try {
    const second = await client.responses.create({
      model: MODEL,
      input: nextHistory,
      tools: [READ_FILE_TOOL],
      store: false,
      reasoning: { effort: "medium" },
    } as OpenAI.Responses.ResponseCreateParamsNonStreaming);
    return {
      round1ReasoningItems: reasoningInfo,
      round2Outcome: "成功（未如預期撞錯，記錄下來）",
      round2Status: second.status,
      round2ToolCalls: extractFunctionCalls(second.output).length,
    };
  } catch (err) {
    const errorInfo = describeError(err);
    console.log("round 2（缺 encrypted_content 續接）錯誤:", maskDeep(errorInfo));
    return {
      round1ReasoningItems: reasoningInfo,
      round2Outcome: "失敗",
      round2Error: errorInfo,
    };
  }
}

// ---------------------------------------------------------------------------
// 測試 C：解構重組的錯誤（v1.3 犯過的那種）——續接時把 reasoning item 整個過濾掉，
// 只保留 function_call / message，模擬「核心誤以為只有 toolCalls 有用」的錯誤心智模型。
// ---------------------------------------------------------------------------

async function testC_droppedReasoningItem() {
  console.log("\n=== 測試 C：續接時故意丟掉 reasoning item，觀察錯誤訊息 ===");

  const history: OpenAI.Responses.ResponseInputItem[] = [
    { role: "user", content: [{ type: "input_text", text: USER_PROMPT }] },
  ];

  const first = await client.responses.create({
    model: MODEL,
    input: history,
    tools: [READ_FILE_TOOL],
    store: false,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "medium" },
  } as OpenAI.Responses.ResponseCreateParamsNonStreaming);

  const functionCalls = extractFunctionCalls(first.output);
  if (functionCalls.length === 0) {
    return { note: "round 1 未觸發 tool call，無法測試此案例" };
  }

  // 刻意只留 function_call，過濾掉 reasoning item——這正是「用 toolCalls 重建請求」
  // 而非「用 raw 整段重送」的錯誤做法（§8 明文警告的錯誤）。
  const droppedOutput = first.output.filter((item) => item.type !== "reasoning");

  const nextHistory: OpenAI.Responses.ResponseInputItem[] = [
    ...history,
    ...(droppedOutput as unknown as OpenAI.Responses.ResponseInputItem[]),
    ...functionCalls.map(
      (call): OpenAI.Responses.ResponseInputItem.FunctionCallOutput => ({
        type: "function_call_output",
        call_id: call.call_id,
        output: fakeResultFor(JSON.parse(call.arguments).path),
      }),
    ),
  ];

  try {
    const second = await client.responses.create({
      model: MODEL,
      input: nextHistory,
      tools: [READ_FILE_TOOL],
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "medium" },
    } as OpenAI.Responses.ResponseCreateParamsNonStreaming);
    return {
      outcome: "成功（未如預期撞錯，記錄下來）",
      status: second.status,
      toolCalls: extractFunctionCalls(second.output).length,
    };
  } catch (err) {
    const errorInfo = describeError(err);
    console.log("round 2（丟掉 reasoning item）錯誤:", maskDeep(errorInfo));
    return { outcome: "失敗", error: errorInfo };
  }
}

// ---------------------------------------------------------------------------
// 測試 D：竄改 encrypted_content 本體（不是拿掉，是讓簽章驗證失敗），
// 直接命中「簽章失效」這條路徑，取得 §13 要的錯誤訊息樣本。
// ---------------------------------------------------------------------------

async function testD_corruptedEncryptedContent() {
  console.log("\n=== 測試 D：竄改 encrypted_content 本體，觀察簽章驗證錯誤 ===");

  const history: OpenAI.Responses.ResponseInputItem[] = [
    { role: "user", content: [{ type: "input_text", text: USER_PROMPT }] },
  ];

  const first = await client.responses.create({
    model: MODEL,
    input: history,
    tools: [READ_FILE_TOOL],
    store: false,
    include: ["reasoning.encrypted_content"],
    reasoning: { effort: "medium" },
  } as OpenAI.Responses.ResponseCreateParamsNonStreaming);

  const functionCalls = extractFunctionCalls(first.output);
  if (functionCalls.length === 0) {
    return { note: "round 1 未觸發 tool call，無法測試此案例" };
  }

  const corruptedOutput = first.output.map((item) => {
    if (item.type === "reasoning" && typeof item.encrypted_content === "string") {
      // 保留長度與前綴（像是合法值），只竄改中段字元，模擬「格式對但簽章驗證不過」
      const c = item.encrypted_content;
      const mid = Math.floor(c.length / 2);
      return { ...item, encrypted_content: c.slice(0, mid) + "XXXXXXXX" + c.slice(mid + 8) };
    }
    return item;
  });

  const nextHistory: OpenAI.Responses.ResponseInputItem[] = [
    ...history,
    ...(corruptedOutput as unknown as OpenAI.Responses.ResponseInputItem[]),
    ...functionCalls.map(
      (call): OpenAI.Responses.ResponseInputItem.FunctionCallOutput => ({
        type: "function_call_output",
        call_id: call.call_id,
        output: fakeResultFor(JSON.parse(call.arguments).path),
      }),
    ),
  ];

  try {
    const second = await client.responses.create({
      model: MODEL,
      input: nextHistory,
      tools: [READ_FILE_TOOL],
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "medium" },
    } as OpenAI.Responses.ResponseCreateParamsNonStreaming);
    return {
      outcome: "成功（未如預期撞錯，記錄下來）",
      status: second.status,
      toolCalls: extractFunctionCalls(second.output).length,
    };
  } catch (err) {
    const errorInfo = describeError(err);
    console.log("round 2（竄改 encrypted_content）錯誤:", maskDeep(errorInfo));
    return { outcome: "失敗", error: errorInfo };
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const outDir = "tmp/verify";
  await mkdir(outDir, { recursive: true });

  const resultA = await testA_normalStatelessMultiRound();
  const resultB = await testB_missingEncryptedContent();
  const resultC = await testC_droppedReasoningItem();
  const resultD = await testD_corruptedEncryptedContent();

  const summary = maskDeep({
    testA_normalStatelessMultiRound: resultA,
    testB_missingEncryptedContent: resultB,
    testC_droppedReasoningItem: resultC,
    testD_corruptedEncryptedContent: resultD,
  });
  const summaryPath = `${outDir}/openai-stateless-summary.json`;
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`\n完整結果（已遮蔽）已寫入 ${summaryPath}`);
}

main().catch((err) => {
  console.error(maskString(String(err)));
  process.exitCode = 1;
});
