import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDb } from "../db.js";
import { approveJob, claimNextJob, finishJob, submitJob } from "../job.js";
import { addSpoke, createTicket } from "../ticket-store.js";
import { recordRound } from "../progress.js";
import { m } from "../messages.js";
import { SERVER_INFO, TOOLS, createProtocol, type RpcResponse } from "./protocol.js";

function withProtocol(run: (protocol: ReturnType<typeof createProtocol>, db: ReturnType<typeof openDb>) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-mcp-protocol-"));
  try {
    const dbPath = path.join(root, "dowafu.db");
    const db = openDb(dbPath);
    db.prepare("INSERT INTO providers (name, base_url, api, store, tool_calling, reasoning, pricing_source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("openai", "https://example.test", "responses", 0, 1, JSON.stringify({ style: "openai", allowed: ["low"], default: "low" }), JSON.stringify({ asOf: "2026-09-02" }), "2026-09-02T00:00:00.000Z");
    db.prepare("INSERT INTO models (provider, model, input_per_m, output_per_m, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("openai", "gpt-5", 1, 2, 1, "2026-09-02T00:00:00.000Z");
    createTicket(db, "ticket-a", "# Under review\ntext\n", "en");
    addSpoke(db, "ticket-a", { agent: "reviewer", provider: "openai", model: "gpt-5", body: "# Questions\n1. Check it\n" }, "en");
    const protocol = createProtocol({ db, dbPath, lang: "en", liveness: () => ({ alive: false, reason: "heartbeat_missing" }) });
    run(protocol, db);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function response(outcome: ReturnType<ReturnType<typeof createProtocol>["handleRpc"]>): RpcResponse {
  assert.ok("response" in outcome);
  return outcome.response;
}

function content(outcome: ReturnType<ReturnType<typeof createProtocol>["handleRpc"]>): string {
  const result = response(outcome).result as { content: Array<{ text: string }> };
  return result.content[0].text;
}

// 工單 approve-tool §零之二：本票推翻票 C 的禁令 #3（不得把 approve 開成 MCP tool）。
// 這條測試原本鎖的是「協定內沒有 approve」，現在反過來鎖「五個 tool，dispatch_approve 在內」
// （A-2 #1）。
test("mcp protocol：宣告五個 tool，dispatch_approve 在內", () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), ["dispatch_tickets", "dispatch_submit", "dispatch_status", "dispatch_result", "dispatch_approve"]);
  assert.deepEqual(TOOLS.find((tool) => tool.name === "dispatch_submit")?.inputSchema.required, ["ticket"]);
  assert.deepEqual(TOOLS.find((tool) => tool.name === "dispatch_approve")?.inputSchema.required, ["jobId", "hardCapUsd"]);
});

test("mcp protocol：initialize echo client protocolVersion 並記錄 capabilities", () => {
  withProtocol((protocol) => {
    const logs: string[] = [];
    const rpc = response(
      protocol.handleRpc(
        { id: 8, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "Codex" }, capabilities: { elicitation: {} } } },
        (line) => logs.push(line),
      ),
    );
    assert.equal(rpc.id, 8);
    assert.deepEqual(rpc.result, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    assert.deepEqual(logs, [
      'clientInfo: {"name":"Codex"}',
      'protocolVersion: "2025-06-18"',
      "capabilities: {\"elicitation\":{}}",
    ]);
  });
});

test("mcp protocol：server/discover 固定回 -32601，notifications 不回應", () => {
  withProtocol((protocol) => {
    const discover = response(protocol.handleRpc({ id: "discover", method: "server/discover" }));
    assert.deepEqual(discover.error, { code: -32601, message: "server/discover not implemented (legacy server)" });
    assert.deepEqual(protocol.handleRpc({ method: "notifications/initialized" }), { none: true });
  });
});

test("mcp protocol：列工單顯示每個 spoke 的 model 與 allowlist 檔數", () => {
  withProtocol((protocol) => {
    const output = content(protocol.handleRpc({ id: 1, method: "tools/call", params: { name: "dispatch_tickets", arguments: {} } }));
    assert.match(output, /ticket-a: 1 spoke/);
    assert.match(output, /reviewer: openai\/gpt-5; allowlist files=0/);
  });
});

test("mcp protocol：submit 立即回 job id、D2a 摘要與 daemon 離線警告", () => {
  withProtocol((protocol, db) => {
    const output = content(
      protocol.handleRpc({ id: 2, method: "tools/call", params: { name: "dispatch_submit", arguments: { ticket: "ticket-a" } } }),
    );
    const match = output.match(/Job queued: ([\w-]+)/);
    assert.ok(match);
    assert.match(output, /DB ticket ticket-a:/);
    assert.match(output, /openai\/gpt-5/);
    assert.match(output, /Price per M tokens/);
    assert.match(output, /Run this in a terminal: node .* approve [\w-]{8}/);
    assert.match(output, /queued but will not execute/);
    assert.equal((db.prepare("SELECT status FROM jobs WHERE id = ?").get(match[1]) as { status: string }).status, "pending_approval");
  });
});

test("mcp protocol：status 在 queue 時警告 daemon 離線，result 在完成前回狀態", () => {
  withProtocol((protocol, db) => {
    const submit = content(
      protocol.handleRpc({ id: 3, method: "tools/call", params: { name: "dispatch_submit", arguments: { ticket: "ticket-a" } } }),
    );
    const jobId = submit.match(/Job queued: ([\w-]+)/)?.[1];
    assert.ok(jobId);
    assert.match(content(protocol.handleRpc({ id: 4, method: "tools/call", params: { name: "dispatch_status", arguments: { jobId } } })), /queued but will not execute/);
    assert.match(content(protocol.handleRpc({ id: 5, method: "tools/call", params: { name: "dispatch_result", arguments: { jobId } } })), /no result is available yet/);

    approveJob(db, jobId);
    claimNextJob(db);
    db.prepare("INSERT INTO results (job_id, agent, output) VALUES (?, ?, ?)").run(jobId, "reviewer", "found a boundary");
    finishJob(db, jobId, { costUsd: 0 });
    const complete = content(protocol.handleRpc({ id: 6, method: "tools/call", params: { name: "dispatch_result", arguments: { jobId } } }));
    assert.match(complete, /Job .* result:/);
    assert.match(complete, /reviewer:\nfound a boundary/);
  });
});

function toolResult(outcome: ReturnType<ReturnType<typeof createProtocol>["handleRpc"]>): { content: Array<{ text: string }>; isError?: boolean } {
  return response(outcome).result as { content: Array<{ text: string }>; isError?: boolean };
}

// 工單 approve-tool §A-2：核准走既有的 approveJob，金額參數與 DB 算出的硬上限相符才放行。
test("mcp protocol：approve 金額相符時走 approveJob，approved_at 有值，即使 daemon 離線（zero-cost 實驗靠這條成立）", () => {
  withProtocol((protocol, db) => {
    const submit = content(
      protocol.handleRpc({ id: 10, method: "tools/call", params: { name: "dispatch_submit", arguments: { ticket: "ticket-a" } } }),
    );
    const jobId = submit.match(/Job queued: ([\w-]+)/)?.[1];
    const hardCapUsd = submit.match(/Hard cap \$([\d.]+)/)?.[1];
    assert.ok(jobId, `找不到 jobId：${submit}`);
    assert.ok(hardCapUsd, `找不到 Hard cap：${submit}`);

    const approveText = content(
      protocol.handleRpc({ id: 11, method: "tools/call", params: { name: "dispatch_approve", arguments: { jobId, hardCapUsd } } }),
    );
    assert.match(approveText, /Approved job: /);
    // A-2 #6：daemon 沒開（withProtocol 的 liveness 固定回 alive:false）approve 照樣成功，
    // 只是照樣印離線警告——沒有 worker 認領，一毛錢都不會花。
    assert.match(approveText, /worker daemon is not running/);
    const row = db.prepare("SELECT status, approved_at FROM jobs WHERE id = ?").get(jobId) as { status: string; approved_at: string | null };
    assert.equal(row.status, "approved");
    assert.ok(row.approved_at);

    // A-2 #4：已核准的 job 再核准一次，不重複、不報成功（approveJob 既有語意，沿用不改）。
    const second = toolResult(protocol.handleRpc({ id: 12, method: "tools/call", params: { name: "dispatch_approve", arguments: { jobId, hardCapUsd } } }));
    assert.equal(second.isError, true);
    assert.match(second.content[0].text, /cannot be approved/);
  });
});

// A-1：比對容許 "$1.77" 與 "1.77" 的格式差異。
test("mcp protocol：approve 接受金額前面帶 $ 的格式差異", () => {
  withProtocol((protocol) => {
    const submit = content(
      protocol.handleRpc({ id: 13, method: "tools/call", params: { name: "dispatch_submit", arguments: { ticket: "ticket-a" } } }),
    );
    const jobId = submit.match(/Job queued: ([\w-]+)/)?.[1];
    const hardCapUsd = submit.match(/Hard cap \$([\d.]+)/)?.[1];
    assert.ok(jobId && hardCapUsd);
    const approveText = content(
      protocol.handleRpc({ id: 14, method: "tools/call", params: { name: "dispatch_approve", arguments: { jobId, hardCapUsd: `$${hardCapUsd}` } } }),
    );
    assert.match(approveText, /Approved job: /);
  });
});

// A-2 #3：金額不符一律拒絕核准，approved_at 維持 null——本票的主要防線（變異 #2 鎖這件事）。
test("mcp protocol：approve 金額不符時拒絕核准，approved_at 維持 null", () => {
  withProtocol((protocol, db) => {
    const submit = content(
      protocol.handleRpc({ id: 15, method: "tools/call", params: { name: "dispatch_submit", arguments: { ticket: "ticket-a" } } }),
    );
    const jobId = submit.match(/Job queued: ([\w-]+)/)?.[1];
    assert.ok(jobId);
    const rejected = toolResult(
      protocol.handleRpc({ id: 16, method: "tools/call", params: { name: "dispatch_approve", arguments: { jobId, hardCapUsd: "0.0001" } } }),
    );
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /amount mismatch|金額不符/);
    const row = db.prepare("SELECT status, approved_at FROM jobs WHERE id = ?").get(jobId) as { status: string; approved_at: string | null };
    assert.equal(row.status, "pending_approval");
    assert.equal(row.approved_at, null);
  });
});

// A-2 #5：找不到的 job id 講人話，不是丟例外。
test("mcp protocol：approve 對不存在的 job 講人話，不丟例外", () => {
  withProtocol((protocol) => {
    const result = toolResult(
      protocol.handleRpc({ id: 17, method: "tools/call", params: { name: "dispatch_approve", arguments: { jobId: "does-not-exist", hardCapUsd: "1" } } }),
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Job not found/);
  });
});

// 熱修補（票 C 手測）：MCP 的 jobId 也接受前綴。
//
// 票 B 的 B-1 #7 原本裁定「只有 CLI 接受前綴」。真 client 上跑一次就打臉：
// dispatch_submit 的回傳印著核准指令 `approve b66b5d47`，Codex 就拿那個短 id 去呼叫
// dispatch_result，被回「找不到」——而那個 job 確實存在。我們親手把 client 教去用
// 一個自己不接受的形式。歧義時仍然不猜，列候選。
test("mcp protocol：status／result 接受 job id 前綴，歧義時列候選不猜", () => {
  const db = openDb(":memory:", "en");
  createTicket(db, "t", "# 待審段落\n內容\n", "en");
  submitJob(db, "t", "aaaa1111-0000-4000-8000-000000000001");
  submitJob(db, "t", "bbbb2222-0000-4000-8000-000000000002");
  submitJob(db, "t", "bbbb2222-0000-4000-8000-000000000003");
  const protocol = createProtocol({ db, dbPath: ":memory:", lang: "en", liveness: () => ({ alive: true, pid: 1 }) });

  const call = (name: string, args: unknown) => {
    const out = protocol.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, () => {});
    if ("none" in out) throw new Error("expected a response");
    return (out.response.result as { content: Array<{ text: string }>; isError?: boolean });
  };

  // 唯一命中的前綴：等同完整 id
  const byPrefix = call("dispatch_status", { jobId: "aaaa1111" });
  assert.ok(!byPrefix.isError, `唯一前綴應該查得到：${byPrefix.content[0].text}`);
  assert.match(byPrefix.content[0].text, /aaaa1111-0000-4000-8000-000000000001/, "回傳的仍必須是完整 id");

  // 完整 id 照舊
  assert.ok(!call("dispatch_result", { jobId: "aaaa1111-0000-4000-8000-000000000001" }).isError);

  // 歧義：不猜，列出候選，且標成 isError
  const ambiguous = call("dispatch_result", { jobId: "bbbb2222" });
  assert.equal(ambiguous.isError, true, "歧義前綴必須是錯誤，不能任選一筆");
  assert.match(ambiguous.content[0].text, /bbbb2222-0000-4000-8000-000000000002/);
  assert.match(ambiguous.content[0].text, /bbbb2222-0000-4000-8000-000000000003/);

  // 真的不存在的仍然是 jobNotFound
  assert.equal(call("dispatch_status", { jobId: "zzzz9999" }).isError, true);
  db.close();
});

// B（gaps #6）：進了 running 之後，dispatch_status 先前什麼都不講——而那正是最需要講的時候。
// 兩個不同的問題各自回答：進度（有在往前走嗎）與心跳（worker 還活著嗎）。
test("mcp protocol：running 時印出每支 spoke 的進度，心跳新鮮就不報警", () => {
  withProtocol((_unused, db) => {
    const job = submitJob(db, "ticket-a");
    approveJob(db, job.id);
    claimNextJob(db);
    recordRound(db, job.id, "reviewer", 3, { inputTokens: 4242, outputTokens: 1717, totalTokens: 5959, available: true }, false);
    db.prepare("UPDATE jobs SET heartbeat_at = ? WHERE id = ?").run("2026-09-07T00:00:00.000Z", job.id);

    const fresh = createProtocol({
      db, dbPath: "/tmp/x.db", lang: "en",
      liveness: () => ({ alive: true, pid: 1, at: 0 }),
      now: () => Date.parse("2026-09-07T00:00:03.000Z"),
    });
    const out = content(fresh.handleRpc({ id: 30, method: "tools/call", params: { name: "dispatch_status", arguments: { jobId: job.id } } }));
    assert.match(out, /reviewer: round 3, 4242 in \/ 1717 out tokens so far/);
    assert.doesNotMatch(out, /heartbeat/);
  });
});

// 工單 status-stdin §A-3（不變量 4／變異 4）：CLI 子行程只在全部 spoke 都失敗時才回
// 非零 exit（cli.ts 的 allFailed 判定），三支死一支照樣 exit 0、job 標成 completed——
// 先前只印 `job <id>: completed`，看不出哪幾支付了錢卻沒拿到東西。
test("mcp protocol：completed 的 job 對「一支成功一支失敗」印出成敗分佈與失敗的 agent 名字", () => {
  withProtocol((_unused, db) => {
    const job = submitJob(db, "ticket-a");
    approveJob(db, job.id);
    claimNextJob(db);
    db.prepare("INSERT INTO results (job_id, agent, output) VALUES (?, ?, ?)").run(job.id, "reviewer", "found a boundary");
    db.prepare("INSERT INTO results (job_id, agent, output) VALUES (?, ?, ?)").run(job.id, "hole-finder-cost", null);
    finishJob(db, job.id, { costUsd: 0 });

    const out = content(createProtocol({ db, dbPath: "/tmp/x.db", lang: "en" }).handleRpc({
      id: 40, method: "tools/call", params: { name: "dispatch_status", arguments: { jobId: job.id } },
    }));
    assert.match(out, /job .*: completed/);
    assert.match(out, /1 succeeded \/ 1 failed/);
    assert.match(out, /\(failed: hole-finder-cost\)/);
    assert.doesNotMatch(out, /reviewer/, "成功的 agent 不列進失敗清單");
  });
});

// 不變量 5（全部成功方向）：不得謊稱有失敗——failed 計數必須是 0，且不附加失敗清單後綴。
test("mcp protocol：completed 的 job 全部成功時，成敗分佈顯示 0 失敗，不附加失敗清單", () => {
  withProtocol((_unused, db) => {
    const job = submitJob(db, "ticket-a");
    approveJob(db, job.id);
    claimNextJob(db);
    db.prepare("INSERT INTO results (job_id, agent, output) VALUES (?, ?, ?)").run(job.id, "reviewer", "found a boundary");
    finishJob(db, job.id, { costUsd: 0 });

    const out = content(createProtocol({ db, dbPath: "/tmp/x.db", lang: "en" }).handleRpc({
      id: 41, method: "tools/call", params: { name: "dispatch_status", arguments: { jobId: job.id } },
    }));
    assert.match(out, /1 succeeded \/ 0 failed/);
    assert.doesNotMatch(out, /\(failed:/);
  });
});

// 不變量 5（全部失敗方向）／§A-3「failed 的 job 也要」：job 本身終態是 failed（子行程
// 全部 spoke 都失敗時 exit 4）時，一樣要印成敗分佈，不得謊稱有成功。
test("mcp protocol：failed 的 job 全部失敗時，成敗分佈顯示 0 成功，列出全部失敗的 agent", () => {
  withProtocol((_unused, db) => {
    const job = submitJob(db, "ticket-a");
    approveJob(db, job.id);
    claimNextJob(db);
    db.prepare("INSERT INTO results (job_id, agent, output) VALUES (?, ?, ?)").run(job.id, "reviewer", null);
    finishJob(db, job.id, { error: "worker exited 4: provider key is not configured", costUsd: 0 });

    const out = content(createProtocol({ db, dbPath: "/tmp/x.db", lang: "en" }).handleRpc({
      id: 42, method: "tools/call", params: { name: "dispatch_status", arguments: { jobId: job.id } },
    }));
    assert.match(out, /job .*: failed/);
    assert.match(out, /0 succeeded \/ 1 failed/);
    assert.match(out, /\(failed: reviewer\)/);
  });
});

test("mcp protocol：running 但心跳過期 → 明講它很可能已經死了", () => {
  withProtocol((_unused, db) => {
    const job = submitJob(db, "ticket-a");
    approveJob(db, job.id);
    claimNextJob(db);
    db.prepare("UPDATE jobs SET heartbeat_at = ? WHERE id = ?").run("2026-09-07T00:00:00.000Z", job.id);

    const stale = createProtocol({
      db, dbPath: "/tmp/x.db", lang: "en",
      liveness: () => ({ alive: true, pid: 1, at: 0 }),
      now: () => Date.parse("2026-09-07T00:02:00.000Z"),
    });
    const out = content(stale.handleRpc({ id: 31, method: "tools/call", params: { name: "dispatch_status", arguments: { jobId: job.id } } }));
    assert.match(out, /heartbeat has not moved for 120s/);
    // 還沒跑完任何一輪也要講——「沒有進度」與「查不到進度」是兩件事。
    assert.match(out, /no round has completed yet/);
  });
});

// 驗收熱修補（票 status-stdin）：dispatch_result 與 cli.ts 的 result 分支同型——
// readResults 的 lang 有預設值而這裡沒傳，於是失敗字樣固定英文。
// 兩種語言必須給出不同的答案，否則固定回英文的實作也會過。
test("mcp protocol：dispatch_result 的失敗字樣跟著 lang 走，不是固定英文", () => {
  withProtocol((_unused, db) => {
    db.prepare("INSERT INTO results (job_id, agent, output) VALUES (?, ?, NULL)").run("ticket-a", "reviewer-dead");
    const job = submitJob(db, "ticket-a");
    approveJob(db, job.id);
    claimNextJob(db);
    finishJob(db, job.id, { costUsd: 0 });
    db.prepare("UPDATE results SET job_id = ? WHERE job_id = 'ticket-a'").run(job.id);

    const ask = (lang: "en" | "zh") =>
      content(
        createProtocol({ db, dbPath: "/tmp/x.db", lang, liveness: () => ({ alive: false, reason: "heartbeat_missing" }) })
          .handleRpc({ id: 40, method: "tools/call", params: { name: "dispatch_result", arguments: { jobId: job.id } } }),
      );

    assert.ok(ask("zh").includes(m("zh", "noFullReportAvailable", "failed")));
    assert.ok(ask("en").includes(m("en", "noFullReportAvailable", "failed")));
  });
});
