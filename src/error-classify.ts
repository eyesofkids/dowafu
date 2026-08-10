// plan_dispatch_v1.8.md §13：錯誤分類依 HTTP status code，不解析錯誤訊息字串——訊息格式
// 各家不同且會改版，status code 是穩定契約。429 不在此分類範圍內（runner.ts 在呼叫此函式
// 之前已用 describeError().is429 攔截，走獨立的 429 等待路徑）。

export type ErrorClass = "transient" | "permanent";

// 暫時性：5xx、408，以及無 HTTP 回應的網路層錯誤（status 為 undefined——連線重置、DNS
// 失敗、AbortController 逾時）。確定性：其他 4xx（400 參數錯、401、403、404…），重試
// 必然再撞同一個錯，不重試。
export function classifyError(status: number | undefined): ErrorClass {
  if (status === undefined) return "transient";
  if (status >= 500 || status === 408) return "transient";
  return "permanent";
}
