import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSpokes } from "./validate.js";
import { DispatchError, type ProvidersFile } from "./types.js";
import type { Ticket } from "./ticket.js";

// plan_dispatch_v1.8.md §20 實作順序第 3 項：「留白 → 送 default」邏輯 ＋ models 白名單
// 檢查。用真實 .claude/agents/ 底下的 agent 定義檔（agentBody 讀取需要實際檔案存在），
// 但工單本身與 providers.json 皆為測試建構的假資料，不碰 tmp/dispatch。

function mkTicket(agent: string, effort?: string, model = "model-a"): Ticket {
  return {
    ticketDir: "tmp/dispatch/fake-ticket-for-validate-test",
    rows: [{ agent, provider: "testprovider", model, effort }],
    shared: { premises: [], reviewText: "待審段落" },
    perAgent: new Map([[agent, { questions: "具體問題", allowedReads: [], lang: "zh" as const }]]),
  };
}

function mkProviders(overrides: Record<string, unknown> = {}): ProvidersFile {
  return {
    testprovider: {
      baseURL: "https://example.test/v1",
      api: "responses",
      store: false,
      toolCalling: true,
      reasoning: { style: "openai", allowed: ["low", "high"], default: "low" },
      models: [],
      charsPerToken: null,
      tpmLimit: null,
      maxSpokeTokens: null,
      ...overrides,
    } as never,
  };
}

const ORIGINAL_ENV = process.env.TESTPROVIDER_API_KEY;
test.before(() => {
  process.env.TESTPROVIDER_API_KEY = "test-key";
});
test.after(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.TESTPROVIDER_API_KEY;
  else process.env.TESTPROVIDER_API_KEY = ORIGINAL_ENV;
});

test("resolveSpokes：effort 留白 → 解析為 providers.json 的 reasoning.default（§5，不再是「不送參數」）", async () => {
  const ticket = mkTicket("hole-finder-cost", undefined);
  const spokes = await resolveSpokes(ticket, mkProviders(), process.cwd());
  assert.equal(spokes[0].effort, "low", "provider 的 reasoning.default 是 low");
});

test("resolveSpokes：effort 明填時仍依原規則驗證，且優先於 default", async () => {
  const ticket = mkTicket("hole-finder-cost", "high");
  const spokes = await resolveSpokes(ticket, mkProviders(), process.cwd());
  assert.equal(spokes[0].effort, "high");
});

test("resolveSpokes：effort 留白但 provider 的 allowed 為空（default 不存在）→ 中止", async () => {
  const ticket = mkTicket("hole-finder-cost", undefined);
  const providers = mkProviders({ reasoning: { style: "openai", allowed: [] } });
  await assert.rejects(
    resolveSpokes(ticket, providers, process.cwd()),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.match(err.message, /reasoning\.default/);
      return true;
    },
  );
});

test("resolveSpokes：models 白名單非空且 model 不在其中 → 中止", async () => {
  const ticket = mkTicket("hole-finder-cost", "low", "not-whitelisted-model");
  const providers = mkProviders({ models: ["model-a", "model-b"] });
  await assert.rejects(
    resolveSpokes(ticket, providers, process.cwd()),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.match(err.message, /models 白名單內/);
      return true;
    },
  );
});

test("resolveSpokes：models 白名單非空且 model 在其中 → 通過", async () => {
  const ticket = mkTicket("hole-finder-cost", "low", "model-b");
  const providers = mkProviders({ models: ["model-a", "model-b"] });
  const spokes = await resolveSpokes(ticket, providers, process.cwd());
  assert.equal(spokes[0].model, "model-b");
});

test("resolveSpokes：models 白名單為空陣列 → 不做型號檢查，任何 model 皆放行", async () => {
  const ticket = mkTicket("hole-finder-cost", "low", "any-model-name");
  const providers = mkProviders({ models: [] });
  const spokes = await resolveSpokes(ticket, providers, process.cwd());
  assert.equal(spokes[0].model, "any-model-name");
});

// plan_dispatch_v1.10.md §9：--repo-root 只影響白名單邊界、.claude/agents 位置、_docs/
// 拒絕判定——用一個獨立於本 repo 的臨時目錄當 repoRoot，證明邊界真的跟著這個參數走，
// 不是繼續暗中鎖死在 process.cwd()。

function mkFakeRepoRoot(): string {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "dispatch-repo-root-"));
  mkdirSync(path.join(repoRoot, ".claude", "agents"), { recursive: true });
  writeFileSync(
    path.join(repoRoot, ".claude", "agents", "hole-finder-cost.md"),
    "---\nmodel: opus\n---\n你是這個假 repoRoot 專屬的 agent body。",
  );
  mkdirSync(path.join(repoRoot, "_docs"), { recursive: true });
  writeFileSync(path.join(repoRoot, "_docs", "secret.md"), "spoke 禁區");
  writeFileSync(path.join(repoRoot, "allowed.txt"), "允許讀取的檔案內容");
  return repoRoot;
}

test("resolveSpokes：--repo-root 決定 .claude/agents 的讀取位置，不是寫死 process.cwd()", async () => {
  const repoRoot = mkFakeRepoRoot();
  try {
    const ticket = mkTicket("hole-finder-cost", "low");
    const spokes = await resolveSpokes(ticket, mkProviders(), repoRoot);
    assert.match(spokes[0].agentBody, /這個假 repoRoot 專屬的 agent body/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("resolveSpokes：允許讀取清單相對 --repo-root 解析，repoRoot 下存在的檔案可放行", async () => {
  const repoRoot = mkFakeRepoRoot();
  try {
    const ticket: Ticket = {
      ticketDir: "tmp/dispatch/fake-ticket-for-validate-test",
      rows: [{ agent: "hole-finder-cost", provider: "testprovider", model: "model-a", effort: "low" }],
      shared: { premises: [], reviewText: "待審段落" },
      perAgent: new Map([["hole-finder-cost", { questions: "具體問題", allowedReads: ["allowed.txt"], lang: "zh" as const }]]),
    };
    const spokes = await resolveSpokes(ticket, mkProviders(), repoRoot);
    assert.equal(spokes[0].allowedReadsResolved.length, 1);
    assert.match(spokes[0].allowedReadsResolved[0], /allowed\.txt$/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("resolveSpokes：_docs/ 拒絕判定相對 --repo-root，不是相對 process.cwd()", async () => {
  const repoRoot = mkFakeRepoRoot();
  try {
    const ticket: Ticket = {
      ticketDir: "tmp/dispatch/fake-ticket-for-validate-test",
      rows: [{ agent: "hole-finder-cost", provider: "testprovider", model: "model-a", effort: "low" }],
      shared: { premises: [], reviewText: "待審段落" },
      perAgent: new Map([["hole-finder-cost", { questions: "具體問題", allowedReads: ["_docs/secret.md"], lang: "zh" as const }]]),
    };
    await assert.rejects(
      resolveSpokes(ticket, mkProviders(), repoRoot),
      (err: unknown) => {
        assert.ok(err instanceof DispatchError);
        assert.match(err.message, /_docs\//);
        return true;
      },
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
