// plan_dispatch_v1.4.md §13：429 等待秒數的三段 fallback。任一階段解析失敗即落入下一段，
// 不猜測。純函式，供單元測試（本節三段 fallback 完全未經實測，見 facts_dispatch.md）。

export type RetryAfterSource = "header" | "message" | "backoff";

export type RetryAfterResult = {
  seconds: number;
  source: RetryAfterSource;
};

const BACKOFF_SECONDS = [2, 4, 8, 16, 32];

export function parseRetryAfter(
  headerValue: string | null | undefined,
  messageText: string | null | undefined,
  attemptIndex: number, // 第幾次撞牆（0-based），決定退避秒數
  now: number = Date.now(),
): RetryAfterResult {
  if (headerValue) {
    const trimmed = headerValue.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      return { seconds: Number(trimmed), source: "header" };
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      const diffSeconds = (parsed - now) / 1000;
      if (diffSeconds > 0) {
        return { seconds: diffSeconds, source: "header" };
      }
    }
  }

  if (messageText) {
    const match = messageText.match(/(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\b/i);
    if (match) {
      return { seconds: Number(match[1]), source: "message" };
    }
  }

  const index = Math.max(0, Math.min(attemptIndex, BACKOFF_SECONDS.length - 1));
  return { seconds: BACKOFF_SECONDS[index], source: "backoff" };
}
