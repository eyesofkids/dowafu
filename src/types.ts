// plan_dispatch_v1.4.md §8：中性表示。raw 原樣保留，不解構重組；toolCalls 是唯讀投影，
// 核心不得用它重建請求（adapter 續接一律用 raw）。

// plan_i18n_v1.2.md §1.1：run-level 語言（--lang > DISPATCH_LANG > 內建預設 en 判定後的
// 權威值），與工單標記無關——見 validate.ts 的 resolveSpokes。原名 TicketLang，T1 階段誤導性
// 地暗示「語言由工單決定」；T7a 更名並從 ticket.ts 搬來這裡（types.ts 零內部 import，
// 不會與任何檔案產生循環）。值維持 "zh" | "en" 不變，純粹改名與搬遷。
export type Lang = "zh" | "en";

export type ToolCall = {
  id: string; // 用於與工具結果關聯（openai/deepseek 的 call_id；gemini 用 part 的 functionCall.id 或退回索引）
  name: string;
  args: Record<string, unknown>;
};

export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; raw: unknown; toolCalls: ToolCall[] }
  | { role: "tool"; callId: string; result: string };

export type Conversation = {
  systemPrompt: string;
  turns: Turn[];
};

// §12 usage 正規化層。available:false 表示該輪取不到可用的 usage（§13 保守收束觸發點）。
export type NormalizedUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  available: boolean;
};

export type SendOptions = {
  model: string;
  effort?: string; // 已通過 providers.json 的 reasoning.allowed 驗證；undefined = 不送任何 reasoning 參數
  enableTools?: boolean; // 預設 true；收束呼叫時設 false，不讓模型再觸發 tool call
  signal?: AbortSignal; // --timeout 逾時控制
};

export type SendMeta = {
  modelReturned: string | null; // 抓 fallback 降級
  finishReason: string; // 正規化：completed/STOP -> "stop"，其餘原樣保留
  finishReasonRaw: string | null;
  requestId: string | null;
  store: "false" | "n/a" | "unknown"; // §6 三態
  text: string | null; // 唯讀投影：本輪若為最終訊息，抽出的純文字（無 tool call 時才有意義）
};

export type SendResult = {
  turn: Turn; // role: "assistant"
  usage: NormalizedUsage;
  usageRaw: unknown;
  meta: SendMeta;
  request: unknown; // 實際送出的完整請求物件（原則 5 的驗證入口：raw/<agent>.request.json）
  response: unknown; // 完整原始回應（raw/<agent>.response.json）
};

// §8：核心只透過此契約與各家互動，不碰任何 provider 專屬結構。
export interface Adapter {
  send(conv: Conversation, opts: SendOptions): Promise<SendResult>;
}

// §5 目標 schema（providers.json）。
export type ReasoningConfig = {
  style: "openai" | "deepseek" | "gemini" | "anthropic" | null;
  allowed: string[]; // 空陣列 = 尚未驗證，任何值皆拒絕（§5「allowed 為空是設計，不是遺漏」）
  // v1.7 起必填（當 allowed 非空時）：工單 effort 留白時實際送出的值，不得回退到
  // 「不送參數」。allowed 為空時 default 不存在——該 provider 不可用，連 default 都無從指定。
  default?: string;
  modelOverrides?: Record<string, string[]>;
};

// plan_fixes_v1.0.md §4：單價，USD／百萬 token，逐模型（同一 provider 底下不同型號
// 單價不同）。cachedInputPerM／cacheWritePerM 缺省時視為與 inputPerM 相同（不折價）——
// 缺席不代表零成本。價目寫死於 providers.json，會隨官方調價過期，須人工複查更新
// （見 _docs/dispatch/pricing_dispatch.md 的查證紀律）。
export type ModelPricing = {
  inputPerM: number;
  cachedInputPerM?: number;
  cacheWritePerM?: number;
  outputPerM: number;
};

export type ProviderConfig = {
  baseURL: string;
  api: "responses" | "gemini-native" | "anthropic-messages";
  store: false | null; // true 不合法，載入即中止（設計原則 6）
  toolCalling: boolean;
  reasoning: ReasoningConfig;
  models: string[]; // §5：工單 model 白名單。空陣列 = 不做型號檢查
  charsPerToken: number | null; // §14：閘門一估算係數，逐家覆寫；null = 用 CLI 全域值
  tpmLimit: number | null;
  maxSpokeTokens: number | null;
  pricing?: Record<string, ModelPricing>; // §4：逐模型單價，缺席的型號無法估算成本（回傳 null，不是 0）
  // v0.2.0：`pricingSource.asOf` 進報表——乾跑要印出本次型號的單價與它的查證日期，
  // hub 才不必去找 providers.json 這個檔。**刻意不收 `url`**：skill 明訂價目來源是這份
  // 檔案、不要查官網（那份數字就是 CLI 的計費基準），把網址印在報表上等於邀請它去查。
  pricingAsOf?: string;
};

export type ProvidersFile = Record<string, ProviderConfig>;

// §7：每次 tool 呼叫（含被拒的）記入 run.jsonl，並標明拒絕原因分類。
export type ToolCallLog = {
  path: string;
  allowed: boolean;
  // tool_limit_exceeded：§7「被拒的呼叫仍計入 --max-tool-calls」——連白名單判定都沒執行到，
  // 在計數這關就被擋下，與白名單三態分開分類，避免和「讀不到／清單外」混淆。
  reason?: "not_found" | "not_in_allowlist" | "outside_repo" | "tool_limit_exceeded";
  startedAt: number;
  durationMs: number;
};

// §13：429 每次撞牆的時間、等待秒數、秒數來源。
export type RateLimitHit = {
  at: number;
  waitSeconds: number;
  source: "header" | "message" | "backoff";
};

// plan_fixes_v1.0.md §6：失敗時完全沒有線索——raw/*.json 只記成功輪次，中斷或失敗原因
// 沒有任何落點。逐次錯誤記錄（不只終局那一次），message／errorBody 已經過 maskString
// 遮蔽（見 mask.ts describeError），request 是失敗當下實際送出的請求（若拿得到）。
export type RawErrorEntry = {
  round: number;
  status: number | null;
  message: string;
  errorBody?: { message: string };
  request?: unknown;
};

// §13 狀態機。
export type SpokeStatus =
  | "succeeded"
  | "truncated:tool_limit"
  | "truncated:budget"
  | "truncated:rate_limit"
  | "truncated:usage_unavailable"
  // v1.6 §13：一般 API 錯誤重試用盡，但已有部分內容——判定原則無條件適用於所有失敗
  // 形態，v1.5 的枚舉漏了這一種，只能回 failed，與原則字面矛盾。收束呼叫不適用此狀態：
  // 它是終局動作，失敗即 failed。
  | "truncated:error"
  | "failed";

// §14：truncated:budget 的觸發來源——三者共用同一狀態，差異屬診斷細節，故不另立狀態，
// 改在 run.jsonl / SpokeRunResult 記來源。reasoning_round 是單輪尖峰（累積抓不到），
// summary.md 須顯眼標示為異常尖峰而非正常超支。
export type BudgetTrigger = "total" | "reasoning" | "reasoning_round";

export type SpokeRunResult = {
  agent: string;
  provider: string;
  api: string;
  modelRequested: string;
  modelReturned: string | null;
  effort?: string;
  store: "false" | "n/a" | "unknown";
  status: SpokeStatus;
  budgetTrigger?: BudgetTrigger; // 僅 status === "truncated:budget" 時有意義
  finalText: string | null;
  usage: NormalizedUsage; // 累積（§14「累積」語意：Σ每輪 usage）
  costUsd: number | null; // §4：依 usage 與 providers.json 的 pricing 估算；缺價目或 usage 不可用時為 null，不是 0
  finishReason: string | null;
  finishReasonRaw: string | null;
  toolCalls: ToolCallLog[];
  rateLimitHits: RateLimitHit[];
  // v2.6 §26 規格四：累積整支 spoke 期間偵測到的未知 usage 欄位（去重，規格五），
  // summary.md 依此顯示告警；空陣列＝未偵測到任何未知欄位。
  unknownUsageKeys: string[];
  attempts: number;
  errors: string[];
  requestId: string | null;
  startedAt: number;
  finishedAt: number;
  latencyMs: number;
  waitedMs: number;
  estimatedPromptTokens: number;
  rawRequests: unknown[]; // 每輪實際送出的完整請求
  rawResponses: unknown[]; // 每輪完整原始回應
  rawErrors: RawErrorEntry[]; // §6：失敗／中斷的逐次錯誤記錄，空陣列＝未撞過任何錯誤
}

// fail-closed 錯誤：帶 exit code，CLI 層 catch 後對應 process.exit（§10）。
export class DispatchError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = "DispatchError";
  }
}
