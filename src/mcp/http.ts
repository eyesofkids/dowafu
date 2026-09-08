// 工單 C §A：daemon 上的 HTTP binding（Streamable HTTP、POST-only、無狀態）。
// 協定層共用 protocol.ts 的 handleRpc，一行都不重複——HTTP 只是換一個傳輸層把訊息餵進去。
//
// 參考實作 tmp/mcp-mvp/http.mjs（128 行，claude.ai 與 Codex 兩個真 client 上跑通過）。
// 照抄形狀，不照抄品質；C-1 的 body 上限判定時機刻意不同（見下方 onData）。

import http from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { findTokenIdForPresented } from "../api-token.js";
import type { Lang } from "../types.js";
import { createProtocol } from "./protocol.js";

export const HTTP_PATH = "/mcp";
export const DEFAULT_HTTP_PORT = 7391;
export const DEFAULT_MAX_BODY_BYTES = 1_000_000;
// C-2：計數存行程內記憶體即可（daemon 是單一行程）。刻意取捨——daemon 重啟時計數歸零，
// 這不是漏洞，是「單人本機工具，重啟後重新累積」的可接受代價，見 report_c.md。
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 30;

// A-2 #12：憑證只記長度，絕不記值，log 與診斷輸出皆然。
const SECRET_HEADER = /^(x-api-key|x-apikey|authorization|cookie|set-cookie)$/i;

function headerSummary(headers: http.IncomingHttpHeaders): string {
  return Object.entries(headers)
    .map(([key, value]) => (SECRET_HEADER.test(key) ? `${key}=<len:${String(value ?? "").length}>` : `${key}=${JSON.stringify(value)}`))
    .join(" ");
}

// C-2：per-token，不是 per-IP——綁 127.0.0.1 + tunnel 之下所有外部流量的來源 IP 都相同，
// per-IP 在這個形態下等於沒有。未認證請求（無效 token 或未帶）全部落在同一個 "unauth"
// 桶，讓「猜 token 的人」本身受限，不因為每次換一個猜測值就重新得到額度。
export function rateLimitBucketKey(tokenId: string | null): string {
  return tokenId ? `token:${tokenId}` : "unauth";
}

type RateLimitOutcome = { limited: boolean; retryAfterSec: number };

function createRateLimiter(windowMs: number, max: number) {
  const buckets = new Map<string, { count: number; windowStart: number }>();
  return {
    check(key: string, nowMs: number): RateLimitOutcome {
      const bucket = buckets.get(key);
      if (!bucket || nowMs - bucket.windowStart >= windowMs) {
        buckets.set(key, { count: 1, windowStart: nowMs });
        return { limited: false, retryAfterSec: 0 };
      }
      bucket.count += 1;
      if (bucket.count > max) {
        const retryAfterSec = Math.max(1, Math.ceil((bucket.windowStart + windowMs - nowMs) / 1000));
        return { limited: true, retryAfterSec };
      }
      return { limited: false, retryAfterSec: 0 };
    },
  };
}

export type HttpServerOptions = {
  db: DatabaseSync;
  dbPath: string;
  lang?: Lang;
  maxBodyBytes?: number;
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
  log?: (line: string) => void;
  now?: () => number;
};

function writeJson(res: http.ServerResponse, status: number, body: unknown, extraHeaders: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(body));
}

// 拆成獨立、可單元測試的 request handler（不倚賴真的 socket），createHttpServer 只是把它
// 接上 http.createServer。F 的多數變異鎖點都靠對這個函式餵假 req/res 驗證，不需要真連線。
export function createRequestHandler(options: HttpServerOptions): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const rateLimiter = createRateLimiter(options.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS, options.rateLimitMax ?? DEFAULT_RATE_LIMIT_MAX_REQUESTS);
  const nowMs = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const protocol = createProtocol({ db: options.db, dbPath: options.dbPath, lang: options.lang ?? "en" });

  return (req, res) => {
    const url = (req.url ?? "").split("?")[0];
    log(`>>> ${req.method} ${url}  headers: ${headerSummary(req.headers)}`);

    if (url !== HTTP_PATH) {
      // 熱修補（票 C 驗收後）：404 原本不印回應行，於是 Codex 那七條 /.well-known/*
      // 探測在 log 裡只看得到 `>>>` 沒有 `<<<`——看起來像伺服器沒回應，實際是回了 404。
      // 「沒有紀錄」與「沒有發生」在排查時被讀成同一件事，那正是 igopms G-78。
      writeJson(res, 404, { error: "not_found" });
      log(`<<< 404 ${req.method} ${url}`);
      return;
    }
    // A-3 #1：Codex 的 client 開場會送 GET /mcp（想開下行 SSE），拿到 405 之後照樣完成
    // 握手（facts_mcp.md）。不要「順手」改成支援 SSE 下行。
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
      log(`<<< 405 ${req.method}`);
      return;
    }

    // A-2 #4：防護順序固定 auth → accept → body，不可調換。rate limit 綁在 auth 的判定
    // 結果上（用哪個桶）一併在這裡處理，仍在 accept／body 之前。
    const presentedRaw = req.headers["x-api-key"];
    const presented = typeof presentedRaw === "string" ? presentedRaw : undefined;
    const tokenId = findTokenIdForPresented(options.db, presented);

    const rl = rateLimiter.check(rateLimitBucketKey(tokenId), nowMs());
    if (rl.limited) {
      res.writeHead(429, { "retry-after": String(rl.retryAfterSec), "content-type": "application/json" });
      res.end(JSON.stringify({ error: "rate_limited", retryAfterSeconds: rl.retryAfterSec }));
      log(`<<< 429 bucket=${rateLimitBucketKey(tokenId)} retryAfter=${rl.retryAfterSec}s`);
      return;
    }

    if (!tokenId) {
      // A-3 #3：claude.ai 下拉選單的預設 header 是 x-apikey（少一個連字號）。401 本身不
      // 提這件事（那是給未認證對象看的），但診斷輸出要點出來，否則使用者看到的 401 沒有線索。
      const wrongName = req.headers["x-apikey"];
      const hint = wrongName ? "  hint: received 'x-apikey' (missing the hyphen) — claude.ai's dropdown default header name" : "";
      log(`    !!! 401 x-api-key=${presented ? `<len:${presented.length}>` : "(none)"}${hint}`);
      writeJson(res, 401, { error: "unauthorized" });
      return;
    }

    // mcp-handler 也是這樣要求的：少一種型別會 406，而 406 常被 client 呈現成「連不到」
    // （A-3 #2；igopms G-77/G-78 燒掉整個排查成本的失敗形態）。
    const accept = String(req.headers.accept ?? "");
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      writeJson(res, 406, { error: "not_acceptable", detail: "Client must accept both application/json and text/event-stream" });
      log(`<<< 406 accept=${JSON.stringify(accept)}`);
      return;
    }

    // C-1：不照抄 MVP 的判定時機。一超過就 destroy，不要等對方送完——不然這個上限只擋得住
    // 記憶體，擋不住頻寬與行程時間。
    let size = 0;
    const chunks: Buffer[] = [];
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > maxBodyBytes) {
        aborted = true;
        writeJson(res, 413, { error: "payload_too_large" });
        log(`<<< 413 size>${maxBodyBytes}`);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", () => {
      aborted = true;
    });
    req.on("end", () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch {
        writeJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        return;
      }
      // 熱修補（票 C 驗收後）：印出 method 與 id。JSON-RPC 的錯誤是**包在 200 裡**回的，
      // 所以原本只印 `<<< 200 sse` 等於什麼都沒說——排查 client 問題時最需要知道的
      // 「它到底叫了什麼、我回了什麼錯」兩項全都看不到。MVP 當初會印整包 body，
      // 我們沒接過來。這裡只印 method／id／錯誤碼，不印 body：tool 參數可能含工單內容。
      const call = msg as { method?: unknown; id?: unknown } | null;
      const method = call && typeof call.method === "string" ? call.method : "(no method)";
      const callId = call && (typeof call.id === "string" || typeof call.id === "number") ? String(call.id) : "-";
      log(`    → ${method} (id=${callId})`);

      // A-1／A-2 #11：同一支 handleRpc，server/discover → -32601 這條也自動涵蓋，HTTP 不
      // 另外處理。A-2 #10：不帶 mcp-session-id header——這裡從未加過，維持不加。
      const outcome = protocol.handleRpc(msg, log);
      if ("none" in outcome) {
        res.writeHead(202);
        res.end();
        log(`<<< 202 (notification) ${method}`);
        return;
      }
      const body = `event: message\ndata: ${JSON.stringify(outcome.response)}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(body);
      // 200 但帶 JSON-RPC error：這是「失敗長得像成功」在傳輸層的原形，一定要標出來。
      const rpcError = outcome.response.error;
      // 「成功」有三層，前兩層今天都被誤讀過一次：
      //   HTTP 200        ≠ 成功——JSON-RPC 的 error 包在 200 裡
      //   JSON-RPC 成功   ≠ 成功——tool 的失敗是 result.isError，不是 JSON-RPC error
      // 第三層(tool 回的內容對不對)不是 log 該管的，但前兩層必須在這行分得出來。
      const toolResult = outcome.response.result as { isError?: boolean } | undefined;
      if (rpcError) log(`<<< 200 sse  ${method} → JSON-RPC error ${rpcError.code}: ${rpcError.message}`);
      else if (toolResult?.isError) log(`<<< 200 sse  ${method} → tool isError`);
      else log(`<<< 200 sse  ${method} ok`);
    });
  };
}

export function createHttpServer(options: HttpServerOptions): http.Server {
  return http.createServer(createRequestHandler(options));
}
