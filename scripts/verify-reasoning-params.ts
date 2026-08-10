// _docs/dispatch/plan_dispatch_v1.7.md §20「第五段的實作順序」第 1 項：驗證兩家的
// reasoning 參數路徑。不通則 §5 的 gemini/deepseek 值域與 default 都要重填，且依
// v1.7 的新規則（allowed 為空 = 該 provider 不可用）gemini 會直接中止。
//
// 1. gemini generateContent 的 thinking 參數：§5 現在填的 allowed/default 取自
//    Interactions API 文件，generateContent 上的參數名與位置沒人驗過。試多個候選形狀，
//    看哪個 200、usageMetadata 有沒有多出推理相關欄位。
// 2. deepseek /v1/responses 的 reasoning_effort：文件只在 chat/completions 章節記載，
//    確認 /v1/responses 是否同名、送了 "low" 是否真的讓 reasoning_tokens 下降
//    （對照第四段實測的失控基準：單輪 output 13,734 中 13,615 是推理）。
//
// 比照前兩次做法：獨立最小腳本，不改本體，錯誤遮蔽從第一支腳本就套用（§12）。

// plan_dispatch_v1.11.md §26：金鑰只該有一個位置——與 CLI 同一條載入路徑
// （$DISPATCH_HOME/.env，ambient 優先），不讀 cwd 的 .env。
import { loadDispatchEnv, resolveDispatchHome } from "../src/dispatch-home.js";
import OpenAI from "openai";
import { writeFile, mkdir } from "node:fs/promises";

loadDispatchEnv(resolveDispatchHome());

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";

const REASONING_PROMPT =
  "有三個人 A、B、C。A 說「B 在說謊」，B 說「C 在說謊」，C 說「A 和 B 都在說謊」。" +
  "如果每個人只會說真話或只會說謊話，請推理出誰說的是真話、誰在說謊，並解釋推理過程。";

// ---------------------------------------------------------------------------
// §12：API key 遮蔽
// ---------------------------------------------------------------------------

const secretValues = [process.env.GEMINI_API_KEY, process.env.DEEPSEEK_API_KEY].filter(
  (v): v is string => Boolean(v && v.length > 0),
);

function maskString(input: string): string {
  let out = input;
  for (const secret of secretValues) {
    out = out.split(secret).join("***REDACTED***");
  }
  out = out.replace(/AIza[A-Za-z0-9_-]{10,}/g, "***REDACTED***");
  out = out.replace(/sk-[A-Za-z0-9]{10,}/g, "***REDACTED***");
  return out;
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
// 1. gemini generateContent：候選 thinking 參數形狀
// ---------------------------------------------------------------------------

const geminiApiKey = process.env.GEMINI_API_KEY;

async function callGemini(body: Record<string, unknown>): Promise<{
  status: number;
  ok: boolean;
  // 只宣告本腳本實際讀取的欄位——回應還有很多其他欄位，這裡不求完整。
  body: { usageMetadata?: Record<string, number> };
}> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": geminiApiKey!, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const json = await res.json();
  return { status: res.status, ok: res.ok, body: json };
}

type GeminiCandidate = { label: string; extra: Record<string, unknown> };

const GEMINI_CANDIDATES: GeminiCandidate[] = [
  { label: "baseline（不帶任何 thinking 參數）", extra: {} },
  {
    label: "generationConfig.thinkingConfig.thinkingLevel=high",
    extra: { generationConfig: { thinkingConfig: { thinkingLevel: "high" } } },
  },
  {
    label: "generationConfig.thinkingConfig.thinking_level=high（snake_case）",
    extra: { generationConfig: { thinkingConfig: { thinking_level: "high" } } },
  },
  {
    label: "generationConfig.thinkingConfig.thinkingBudget=1024（數值型，2.5 系列常見寫法）",
    extra: { generationConfig: { thinkingConfig: { thinkingBudget: 1024 } } },
  },
  {
    label: "generationConfig.thinkingConfig.thinkingBudget=0（關閉推理，對照組）",
    extra: { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
  },
  {
    label: "頂層 thinking_level=high（不在 generationConfig 底下）",
    extra: { thinking_level: "high" },
  },
];

async function verifyGemini() {
  const results: Record<string, unknown>[] = [];
  if (!geminiApiKey) {
    console.log("缺少 GEMINI_API_KEY，跳過 gemini 驗證");
    return results;
  }

  for (const candidate of GEMINI_CANDIDATES) {
    const body = {
      contents: [{ role: "user", parts: [{ text: REASONING_PROMPT }] }],
      ...candidate.extra,
    };
    console.log(`\n--- gemini candidate: ${candidate.label} ---`);
    try {
      const { status, ok, body: respBody } = await callGemini(body);
      const usage = respBody?.usageMetadata;
      const record = {
        label: candidate.label,
        requestExtra: candidate.extra,
        status,
        ok,
        usageMetadata: usage ?? null,
        // 抓任何看起來跟推理/thought 有關的欄位名，不假設固定叫什麼
        thoughtRelatedKeys: usage ? Object.keys(usage).filter((k) => /thought|thinking|reasoning/i.test(k)) : [],
        errorMessage: ok ? null : maskString(JSON.stringify(respBody)),
      };
      results.push(record);
      console.log(maskDeep(record));
    } catch (err) {
      const record = { label: candidate.label, error: maskString(String(err)) };
      results.push(record);
      console.log(record);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// 2. deepseek /v1/responses：reasoning_effort 是否生效
// ---------------------------------------------------------------------------

async function verifyDeepseek() {
  const results: Record<string, unknown>[] = [];
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.log("缺少 DEEPSEEK_API_KEY，跳過 deepseek 驗證");
    return results;
  }

  const client = new OpenAI({ apiKey, baseURL: "https://api.deepseek.com/v1" });

  const scenarios: Array<{ label: string; extra: Record<string, unknown> }> = [
    { label: "baseline（不帶任何 reasoning 參數，對照第四段的失控基準）", extra: {} },
    {
      label: "thinking:{type:enabled} + reasoning_effort:low",
      extra: { thinking: { type: "enabled" }, reasoning_effort: "low" },
    },
    {
      label: "只帶 reasoning_effort:low（不帶 thinking，測試是否為必要搭配）",
      extra: { reasoning_effort: "low" },
    },
    {
      label: "thinking:{type:disabled}（完全關閉，對照組）",
      extra: { thinking: { type: "disabled" } },
    },
  ];

  for (const scenario of scenarios) {
    console.log(`\n--- deepseek scenario: ${scenario.label} ---`);
    try {
      const response = await client.responses.create({
        model: DEEPSEEK_MODEL,
        input: REASONING_PROMPT,
        ...scenario.extra,
      } as OpenAI.Responses.ResponseCreateParamsNonStreaming);

      const usage = response.usage as unknown as Record<string, unknown> | undefined;
      const outputTokens = (usage?.output_tokens as number) ?? null;
      const reasoningTokens =
        ((usage?.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens as number) ?? null;
      const record = {
        label: scenario.label,
        requestExtra: scenario.extra,
        status: response.status,
        outputTokens,
        reasoningTokens,
        reasoningRatio:
          typeof outputTokens === "number" && typeof reasoningTokens === "number" && outputTokens > 0
            ? Number((reasoningTokens / outputTokens).toFixed(3))
            : null,
      };
      results.push(record);
      console.log(maskDeep(record));
    } catch (err) {
      const anyErr = err as { status?: number; message?: string; error?: unknown };
      const record = {
        label: scenario.label,
        error: true,
        status: anyErr?.status ?? null,
        message: maskString(anyErr?.message ?? String(err)),
      };
      results.push(record);
      console.log(maskDeep(record));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------

async function main() {
  const outDir = "tmp/verify";
  await mkdir(outDir, { recursive: true });

  console.log("\n=== 1. gemini generateContent thinking 參數路徑 ===");
  const geminiResults = await verifyGemini();

  console.log("\n=== 2. deepseek /v1/responses reasoning_effort ===");
  const deepseekResults = await verifyDeepseek();

  const summary = { gemini: maskDeep(geminiResults), deepseek: maskDeep(deepseekResults) };
  const summaryPath = `${outDir}/reasoning-params-summary.json`;
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`\n完整結果（已遮蔽）已寫入 ${summaryPath}`);
}

main().catch((err) => {
  console.error(maskString(String(err)));
  process.exitCode = 1;
});
