import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { openDb } from "../db.js";
import { createTicket } from "../ticket-store.js";
import { SERVER_INFO } from "./protocol.js";
import { startStdioServer } from "./stdio.js";

function readChunks(stream: PassThrough): string[] {
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));
  return chunks;
}

test("mcp stdio：stdout 只輸出一行合法 JSON-RPC；診斷與 capabilities 留在 stderr", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-mcp-stdio-"));
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = new PassThrough();
    const stdout = readChunks(output);
    const diagnostics = readChunks(stderr);
    let exitCode: number | undefined;
    startStdioServer({ dbPath: path.join(root, "dowafu.db"), input, output, stderr, exit: (code) => (exitCode = code) });
    input.write("not json\n");
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{"roots":{}}}}\n');
    await new Promise((resolve) => setImmediate(resolve));

    const lines = stdout.join("").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      jsonrpc: "2.0",
      id: 1,
      // 工單 C §E：版號改讀 pkg-info（getPackageVersion），不再寫死——比對 SERVER_INFO
      // 本身而不是字面量，這樣未來 bump 版本不必回頭改這個斷言。
      result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: SERVER_INFO },
    });
    assert.match(diagnostics.join(""), /invalid JSON-RPC input/);
    assert.match(diagnostics.join(""), /capabilities: {"roots":{}}/);
    input.end();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mcp stdio：server/discover 的 JSON-RPC 錯誤仍是 stdout 上唯一合法訊息", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-mcp-discover-"));
  try {
    const input = new PassThrough();
    const output = new PassThrough();
    const stdout = readChunks(output);
    startStdioServer({ dbPath: path.join(root, "dowafu.db"), input, output, stderr: new PassThrough(), exit: () => {} });
    input.write('{"jsonrpc":"2.0","id":"d","method":"server/discover"}\n');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(JSON.parse(stdout.join("")), {
      jsonrpc: "2.0",
      id: "d",
      error: { code: -32601, message: "server/discover not implemented (legacy server)" },
    });
    input.end();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mcp stdio：dispatch_tickets 經共用 protocol 顯示 draft 狀態與定稿指令", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-mcp-stdio-ticket-state-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    const db = openDb(dbPath, "en");
    createTicket(db, "draft-ticket", "# Under review\ntext\n", "en");
    db.close();

    const input = new PassThrough();
    const output = new PassThrough();
    const stdout = readChunks(output);
    startStdioServer({ dbPath, input, output, stderr: new PassThrough(), exit: () => {} });
    input.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"dispatch_tickets","arguments":{}}}\n');
    await new Promise((resolve) => setImmediate(resolve));

    const response = JSON.parse(stdout.join("")) as { result: { content: Array<{ text: string }> } };
    assert.match(response.result.content[0].text, /\[draft\] Draft — cannot be dispatched/);
    assert.match(response.result.content[0].text, /ticket seal draft-ticket --repo-root <repo root>/);
    input.end();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
