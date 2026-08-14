// plan_dispatch_v1.8.md §13：錯誤分類依 HTTP status code，不解析錯誤訊息字串——訊息格式
// 各家不同且會改版，status code 是穩定契約。429 不在此分類範圍內（runner.ts 在呼叫此函式
// 之前已用 describeError().is429 攔截，走獨立的 429 等待路徑）。

export type ErrorClass = "transient" | "permanent";

// 暫時性：5xx、408，以及無 HTTP 回應的網路層錯誤（連線重置、DNS 失敗、AbortController
// 逾時）。確定性：其他 4xx（400 參數錯、401、403、404…），重試必然再撞同一個錯，不重試。
//
// **「無 HTTP 回應」有兩種表示法，兩種都要收**：`undefined`（錯誤物件根本沒有 status），
// 以及 **`0`**——`adapters/responses.ts` 把 OpenAI SDK 的 `APIConnectionError` 正規化成
// `anyErr.status ?? 0`，而那個 SDK 的連線錯誤**帶著 `status` 這個欄位、值為 undefined**，
// 所以會走進 `?? 0`。`0` 不是合法的 HTTP status code，拿它當「沒有回應」的哨兵是安全的。
//
// v0.3.0 對測（2026-08-13）實地踩到：DeepSeek 連線失敗 → status 0 → 判成 permanent →
// **`--retries` 一次都沒用上**，四支 spoke 在 1.2–1.5 秒內全部 failed。
// 本函式的註解原本就寫著網路層錯誤該重試，是 `?? 0` 讓那個意圖失效；測試也只測了
// `undefined`，剛好漏掉 `0`。
export function classifyError(status: number | undefined): ErrorClass {
  if (status === undefined || status === 0) return "transient";
  if (status >= 500 || status === 408) return "transient";
  return "permanent";
}
