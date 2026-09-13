import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { issueToken } from "../api-token.js";
import { openDb } from "../db.js";
import { createTicket } from "../ticket-store.js";
import { createHttpServer, createRequestHandler, rateLimitBucketKey, DEFAULT_HTTP_PORT } from "./http.js";

// 不倚賴真的 socket：req 只需要 handler 實際用到的四樣東西（method/url/headers/on/destroy），
// res 只需要 writeHead/end。真連線的驗證另外用 withRealServer（127.0.0.1 綁定、SSE 格式）。
class FakeReq extends EventEmitter {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  destroyed = false;
  constructor(opts: { method?: string; url?: string; headers?: IncomingHttpHeaders }) {
    super();
    this.method = opts.method ?? "POST";
    this.url = opts.url ?? "/mcp";
    this.headers = opts.headers ?? {};
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeRes {
  statusCode: number | undefined;
  headers: Record<string, unknown> = {};
  body = "";
  ended = false;
  writeHead(status: number, headers?: Record<string, unknown>): void {
    this.statusCode = status;
    Object.assign(this.headers, headers);
  }
  end(chunk?: string): void {
    if (chunk) this.body += chunk;
    this.ended = true;
  }
}

function withDb(run: (db: ReturnType<typeof openDb>, dbPath: string) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-http-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    run(openDb(dbPath), dbPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const ACCEPT_BOTH = "application/json, text/event-stream";

function withHandler(
  db: ReturnType<typeof openDb>,
  dbPath: string,
  overrides: Partial<Parameters<typeof createRequestHandler>[0]> = {},
) {
  const logs: string[] = [];
  const handler = createRequestHandler({ db, dbPath, log: (line) => logs.push(line), ...overrides });
  return { handler, logs };
}

test("http：非 /mcp 路徑一律 404", () => {
  withDb((db, dbPath) => {
    const { handler } = withHandler(db, dbPath);
    const req = new FakeReq({ url: "/other" });
    const res = new FakeRes();
    handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    assert.equal(res.statusCode, 404);
  });
});

test("http：GET /mcp 回 405 並帶 allow: POST（A-3 #1，Codex 靠這個完成握手）", () => {
  withDb((db, dbPath) => {
    const { handler } = withHandler(db, dbPath);
    const req = new FakeReq({ method: "GET" });
    const res = new FakeRes();
    handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, "POST");
  });
});

test("http：防護順序 auth 先於 accept——未認證且 accept 也不對，回 401 不是 406", () => {
  withDb((db, dbPath) => {
    const { handler } = withHandler(db, dbPath);
    const req = new FakeReq({ headers: { accept: "application/json" } }); // 缺 x-api-key 且 accept 也不完整
    const res = new FakeRes();
    handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    assert.equal(res.statusCode, 401);
  });
});

test("http：x-api-key 不符回 401，且未撤銷相符才算數", () => {
  withDb((db, dbPath) => {
    issueToken(db, "laptop");
    const { handler } = withHandler(db, dbPath);
    const req = new FakeReq({ headers: { "x-api-key": "not-the-right-token", accept: ACCEPT_BOTH } });
    const res = new FakeRes();
    handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    assert.equal(res.statusCode, 401);
  });
});

test("http：accept 缺一種型別回 406（A-3 #2）", () => {
  withDb((db, dbPath) => {
    const { plaintext } = issueToken(db, "laptop");
    const { handler } = withHandler(db, dbPath);
    const req = new FakeReq({ headers: { "x-api-key": plaintext, accept: "application/json" } });
    const res = new FakeRes();
    handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    assert.equal(res.statusCode, 406);
  });
});

test("http：body 一超過上限就 destroy，不等對方送完（鎖住 C-1，非讀完再判）", () => {
  withDb((db, dbPath) => {
    const { plaintext } = issueToken(db, "laptop");
    const { handler } = withHandler(db, dbPath, { maxBodyBytes: 10 });
    const req = new FakeReq({ headers: { "x-api-key": plaintext, accept: ACCEPT_BOTH } });
    const res = new FakeRes();
    handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    req.emit("data", Buffer.from("this chunk is definitely more than ten bytes"));
    // 刻意不 emit "end"——若實作退回 MVP 的「讀完再判」，destroy 不會在這裡發生。
    assert.equal(req.destroyed, true);
    assert.equal(res.statusCode, 413);
  });
});

test("http：body 在限制內時正常處理到 end（不誤傷正常請求）", () => {
  withDb((db, dbPath) => {
    const { plaintext } = issueToken(db, "laptop");
    const { handler } = withHandler(db, dbPath);
    const req = new FakeReq({ headers: { "x-api-key": plaintext, accept: ACCEPT_BOTH } });
    const res = new FakeRes();
    handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    req.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })));
    req.emit("end");
    assert.equal(req.destroyed, false);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] as string, /text\/event-stream/);
    assert.match(res.body, /^event: message\ndata: /);
    const payload = JSON.parse(res.body.replace(/^event: message\ndata: /, "").trim());
    assert.deepEqual(payload, { jsonrpc: "2.0", id: 1, result: {} });
  });
});

test("http：JSON 解析失敗回 400 + -32700", () => {
  withDb((db, dbPath) => {
    const { plaintext } = issueToken(db, "laptop");
    const { handler } = withHandler(db, dbPath);
    const req = new FakeReq({ headers: { "x-api-key": plaintext, accept: ACCEPT_BOTH } });
    const res = new FakeRes();
    handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    req.emit("data", Buffer.from("not json"));
    req.emit("end");
    assert.equal(res.statusCode, 400);
    assert.deepEqual(JSON.parse(res.body).error, { code: -32700, message: "parse error" });
  });
});

test("http：notification（無 id）回 202 空 body", () => {
  withDb((db, dbPath) => {
    const { plaintext } = issueToken(db, "laptop");
    const { handler } = withHandler(db, dbPath);
    const req = new FakeReq({ headers: { "x-api-key": plaintext, accept: ACCEPT_BOTH } });
    const res = new FakeRes();
    handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    req.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })));
    req.emit("end");
    assert.equal(res.statusCode, 202);
    assert.equal(res.body, "");
  });
});

test("http：server/discover 走 HTTP 這條路也回 -32601（A-2 #11，同一支 handleRpc）", () => {
  withDb((db, dbPath) => {
    const { plaintext } = issueToken(db, "laptop");
    const { handler } = withHandler(db, dbPath);
    const req = new FakeReq({ headers: { "x-api-key": plaintext, accept: ACCEPT_BOTH } });
    const res = new FakeRes();
    handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    req.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: "d1", method: "server/discover" })));
    req.emit("end");
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body.replace(/^event: message\ndata: /, "").trim());
    assert.deepEqual(payload.error, { code: -32601, message: "server/discover not implemented (legacy server)" });
  });
});

test("http：回應不帶 mcp-session-id header（A-2 #10）", () => {
  withDb((db, dbPath) => {
    const { plaintext } = issueToken(db, "laptop");
    const { handler } = withHandler(db, dbPath);
    const req = new FakeReq({ headers: { "x-api-key": plaintext, accept: ACCEPT_BOTH } });
    const res = new FakeRes();
    handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    req.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })));
    req.emit("end");
    assert.equal("mcp-session-id" in res.headers, false);
  });
});

test("http：401 收到 x-apikey（少連字號）時，診斷輸出點出提示，401 body 不洩漏", () => {
  withDb((db, dbPath) => {
    const { logs, handler } = withHandler(db, dbPath);
    const req = new FakeReq({ headers: { "x-apikey": "guessed-value", accept: ACCEPT_BOTH } });
    const res = new FakeRes();
    handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    assert.ok(logs.some((l) => l.includes("x-apikey") && l.includes("hyphen")));
    assert.doesNotMatch(res.body, /guessed-value/);
    assert.doesNotMatch(res.body, /hyphen/);
  });
});

test("http：憑證診斷輸出只記長度，不記值", () => {
  withDb((db, dbPath) => {
    const { logs, handler } = withHandler(db, dbPath);
    const req = new FakeReq({ headers: { "x-api-key": "super-secret-value-do-not-leak" } });
    const res = new FakeRes();
    handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
    assert.ok(!logs.some((l) => l.includes("super-secret-value-do-not-leak")));
    assert.ok(logs.some((l) => l.includes("x-api-key=<len:")));
  });
});

test("http：rateLimitBucketKey 對不同 token 給不同桶，對未認證給固定桶（鎖住 C-2 per-token）", () => {
  assert.notEqual(rateLimitBucketKey("token-a"), rateLimitBucketKey("token-b"));
  assert.equal(rateLimitBucketKey(null), rateLimitBucketKey(null));
  assert.notEqual(rateLimitBucketKey("token-a"), rateLimitBucketKey(null));
});

test("http：超過 rate limit 回 429 帶 retry-after；不同 token 各自獨立額度", () => {
  withDb((db, dbPath) => {
    const tokenA = issueToken(db, "a");
    const tokenB = issueToken(db, "b");
    const { handler } = withHandler(db, dbPath, { rateLimitMax: 1, rateLimitWindowMs: 60_000 });
    const send = (plaintext: string) => {
      const req = new FakeReq({ headers: { "x-api-key": plaintext, accept: ACCEPT_BOTH } });
      const res = new FakeRes();
      handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      req.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })));
      req.emit("end");
      return res;
    };
    assert.equal(send(tokenA.plaintext).statusCode, 200);
    const second = send(tokenA.plaintext);
    assert.equal(second.statusCode, 429);
    assert.ok(typeof second.headers["retry-after"] === "string");
    // 不同 token：A 的額度用完不影響 B——per-token，不是共用單一桶（也不是 per-IP）。
    assert.equal(send(tokenB.plaintext).statusCode, 200);
  });
});

test("http：未認證請求也計數，落在同一個 unauth 桶（猜 token 的人受限）", () => {
  withDb((db, dbPath) => {
    const { handler } = withHandler(db, dbPath, { rateLimitMax: 1, rateLimitWindowMs: 60_000 });
    const send = (guess: string) => {
      const req = new FakeReq({ headers: { "x-api-key": guess, accept: ACCEPT_BOTH } });
      const res = new FakeRes();
      handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
      return res;
    };
    assert.equal(send("guess-1").statusCode, 401);
    // 換一個猜測值，一樣落在 unauth 共用桶——不是「每個猜測值各自一份額度」。
    const limited = send("guess-2");
    assert.equal(limited.statusCode, 429);
  });
});

function withRealServer(run: (baseUrl: string, db: ReturnType<typeof openDb>) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-http-real-"));
    const dbPath = path.join(root, "dowafu.db");
    const db = openDb(dbPath);
    const server = createHttpServer({ db, dbPath, log: () => {} });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : DEFAULT_HTTP_PORT;
      run(`http://127.0.0.1:${port}`, db)
        .then(resolve, reject)
        .finally(() => {
          server.close();
          rmSync(root, { recursive: true, force: true });
        });
    });
  });
}

test("http（真連線）：帶正確 token 走完整 SSE 往返", async () => {
  await withRealServer(async (baseUrl, db) => {
    const { plaintext } = issueToken(db, "laptop");
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { accept: ACCEPT_BOTH, "content-type": "application/json", "x-api-key": plaintext },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /^event: message\ndata: /);
    assert.deepEqual(JSON.parse(text.replace(/^event: message\ndata: /, "").trim()), { jsonrpc: "2.0", id: 1, result: {} });
  });
});

test("http（真連線）：dispatch_tickets 經共用 protocol 顯示 draft 狀態與定稿指令", async () => {
  await withRealServer(async (baseUrl, db) => {
    const { plaintext } = issueToken(db, "laptop");
    createTicket(db, "draft-ticket", "# Under review\ntext\n", "en");
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { accept: ACCEPT_BOTH, "content-type": "application/json", "x-api-key": plaintext },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "dispatch_tickets", arguments: {} } }),
    });
    assert.equal(res.status, 200);
    const payload = JSON.parse((await res.text()).replace(/^event: message\ndata: /, "").trim()) as { result: { content: Array<{ text: string }> } };
    assert.match(payload.result.content[0].text, /\[draft\] Draft — cannot be dispatched/);
    assert.match(payload.result.content[0].text, /ticket seal draft-ticket --repo-root <repo root>/);
  });
});

test("http（真連線）：無 token 回 401", async () => {
  await withRealServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { accept: ACCEPT_BOTH, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(res.status, 401);
  });
});

test("http（真連線）：GET /mcp 回 405（A-2 #1，只綁 127.0.0.1，不帶 --host）", async () => {
  await withRealServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/mcp`, { method: "GET" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  });
});
