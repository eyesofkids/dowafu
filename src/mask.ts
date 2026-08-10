// plan_dispatch_v1.4.md §12：API key 不得出現在任何落檔、stdout 或錯誤訊息中。
// 遮蔽同時套用於 run.jsonl、raw/*.json 與 stdout 三個出口。刻意不對 error 物件
// 做 JSON.stringify(error)：SDK 的 error 物件可能帶著 request headers。

const REDACTED_HEADER_KEYS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
]);

let secretValues: string[] = [];

// 啟動時登錄本次載入的所有金鑰值，逐一從輸出字串中剔除；正則是 sk-/AIza 等已知前綴的兜底，
// 不倚賴單一機制。
export function registerSecrets(values: Array<string | undefined>): void {
  secretValues = values.filter((v): v is string => Boolean(v && v.length > 0));
}

export function maskString(input: string): string {
  let out = input;
  for (const secret of secretValues) {
    out = out.split(secret).join("***REDACTED***");
  }
  out = out.replace(/sk-[A-Za-z0-9]{10,}/g, "***REDACTED***");
  out = out.replace(/ghp_[A-Za-z0-9]{10,}/g, "***REDACTED***");
  out = out.replace(/AIza[A-Za-z0-9_-]{10,}/g, "***REDACTED***");
  return out;
}

export function maskHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    out[key] = REDACTED_HEADER_KEYS.has(key.toLowerCase())
      ? "***REDACTED***"
      : maskString(String(value));
  }
  return out;
}

export function maskDeep(value: unknown): unknown {
  if (typeof value === "string") return maskString(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskDeep(v)]),
    );
  }
  return value;
}

export type DescribedError = {
  status?: number;
  is429: boolean;
  retryAfterHeader: string | null;
  message?: string;
  errorBody?: { message: string };
  headers?: Record<string, string>;
};

export function describeError(err: unknown): DescribedError {
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
  return { is429: false, retryAfterHeader: null, message: maskString(String(err)) };
}

// 供 adapter 拋出時附掛 status/headers/error（責一致的形狀給 describeError 讀）。
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly headers: Record<string, string>,
    public readonly error: unknown,
    // §13：「raw 帶回導致的 400」須保留該次完整請求供比對，故錯誤本身也帶著它。
    public readonly request?: unknown,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}
