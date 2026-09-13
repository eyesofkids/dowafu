import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSpokes } from "./validate.js";
import { DispatchError, type ProvidersFile } from "./types.js";
import { parseAgentTicket, type Ticket } from "./ticket.js";
import { m } from "./messages.js";

// plan_dispatch_v1.8.md §20 實作順序第 3 項：「留白 → 送 default」邏輯 ＋ models 白名單
// 檢查。用真實 .claude/agents/ 底下的 agent 定義檔（agentBody 讀取需要實際檔案存在），
// 但工單本身與 providers.json 皆為測試建構的假資料，不碰 tmp/dispatch。
//
// hub 裁決（2026-08-12，同 ticket.test.ts 檔頭）：8 個 2 個以上同型（string）參數的 key
// （effortBlankNoDefault／effortNotAllowed／modelNotWhitelisted／providerUndefinedInRow／
// missingEnvVar／agentDefNotFound／allowedReadsUnderDocs／allowedReadsPathNotFound）改用
// 手寫字面量斷言，不透過 m() 重建——m() 重建驗不到訊息模板自己的插值順序寫錯（期望值與
// 被測物出自同一個模板，一起錯、一起對）。其餘沿用 m() 重建（單參數 key，或
// internalErrorTicketContentMissing 這種型別各異、typecheck 擋得住的 key）。

function mkTicket(agent: string, effort?: string, model = "model-a"): Ticket {
  return {
    ticketDir: "tmp/dispatch/fake-ticket-for-validate-test",
    rows: [{ agent, provider: "testprovider", model, effort }],
    shared: { premises: [], reviewText: "待審段落", strayHeadings: [] },
    perAgent: new Map([[agent, { questions: "具體問題", allowedReads: [] }]]),
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
      models: ["model-a"],
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

// plan_i18n_v1.2.md §2.3／plan_i18n_v1.3.md §一之3：validate.ts:142 的改動 typecheck
// 抓不到「改錯」（硬編 lang:"en"、直接讀 process.env 都能編過），要靠這條測試守。
// 用「具體問題」（中文標記）解析出的工單配 --lang en 注入，斷言 ResolvedSpoke.lang
// 仍是 "en"——證明語言完全由注入值決定，與工單標記無關。
test("resolveSpokes：中文標記的工單配注入 lang=\"en\"，ResolvedSpoke.lang 仍為 en（v1.2 §2.3）", async () => {
  const agentTicket = parseAgentTicket("# 具體問題\n1. 問題一\n", "zh");
  const ticket: Ticket = {
    ticketDir: "tmp/dispatch/fake-ticket-for-validate-test",
    rows: [{ agent: "hole-finder-cost", provider: "testprovider", model: "model-a", effort: "low" }],
    shared: { premises: [], reviewText: "待審段落", strayHeadings: [] },
    perAgent: new Map([["hole-finder-cost", agentTicket]]),
  };
  const spokesEn = await resolveSpokes(ticket, mkProviders(), process.cwd(), "en", () => true, () => true, undefined);
  assert.equal(spokesEn[0].lang, "en");
  // 對照組：同一份工單換注入 "zh"，證明真的是注入值在決定，不是巧合。
  const spokesZh = await resolveSpokes(ticket, mkProviders(), process.cwd(), "zh", () => true, () => true, undefined);
  assert.equal(spokesZh[0].lang, "zh");
});

test("resolveSpokes：effort 留白 → 解析為 providers.json 的 reasoning.default（§5，不再是「不送參數」）", async () => {
  const ticket = mkTicket("hole-finder-cost", undefined);
  const spokes = await resolveSpokes(ticket, mkProviders(), process.cwd(), "zh", () => true, () => true, undefined);
  assert.equal(spokes[0].effort, "low", "provider 的 reasoning.default 是 low");
});

test("resolveSpokes：effort 明填時仍依原規則驗證，且優先於 default", async () => {
  const ticket = mkTicket("hole-finder-cost", "high");
  const spokes = await resolveSpokes(ticket, mkProviders(), process.cwd(), "zh", () => true, () => true, undefined);
  assert.equal(spokes[0].effort, "high");
});

// effortBlankNoDefault [agent, provider]：2 個同型參數，手寫字面量斷言（hub 裁決 2026-08-12：
// m() 重建驗不到模板自己的插值順序寫錯，見檔頭說明）。
test("resolveSpokes：effort 留白但 provider 的 allowed 為空（default 不存在）→ 中止，訊息依 lang（zh／en，手寫字面量）", async () => {
  const ticket = mkTicket("hole-finder-cost", undefined);
  const providers = mkProviders({ reasoning: { style: "openai", allowed: [] } });
  await assert.rejects(
    resolveSpokes(ticket, providers, process.cwd(), "zh", () => true, () => true, undefined),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(
        err.message,
        '"hole-finder-cost" 列的 effort 留白，但 provider "testprovider" 未設 reasoning.default（allowed 為空 = 尚未驗證，該 provider 不可用）',
      );
      return true;
    },
  );
  await assert.rejects(
    resolveSpokes(ticket, providers, process.cwd(), "en", () => true, () => true, undefined),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(
        err.message,
        'The "hole-finder-cost" row\'s effort is blank, but provider "testprovider" has no reasoning.default set (empty allowed = not yet verified; this provider is unavailable)',
      );
      return true;
    },
  );
});

// effortNotAllowed [agent, effort, provider, list]：4 個同型參數，手寫字面量斷言（hub 裁決）。
test("resolveSpokes：effort 明填但不在 provider 的允許值域內 → 中止，訊息依 lang（zh／en，手寫字面量）", async () => {
  const ticket = mkTicket("hole-finder-cost", "medium");
  await assert.rejects(
    resolveSpokes(ticket, mkProviders(), process.cwd(), "zh", () => true, () => true, undefined),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(
        err.message,
        '"hole-finder-cost" 列的 effort "medium" 不在 provider "testprovider" 的允許值域內（允許值：low, high）',
      );
      return true;
    },
  );
  await assert.rejects(
    resolveSpokes(ticket, mkProviders(), process.cwd(), "en", () => true, () => true, undefined),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(
        err.message,
        'The "hole-finder-cost" row\'s effort "medium" is not in provider "testprovider"\'s allowed range (allowed: low, high)',
      );
      return true;
    },
  );
});

// allowed 為空時，effort 明填仍會撞上這條分支——list 改用 emptyAllowedNote（較長的說明句），
// 與上面 default 缺失分支共用的 emptyList（僅「（空）」二字）是兩個不同 key，不要混用。
test("resolveSpokes：effort 明填但 provider 的 allowed 為空陣列 → list 顯示 emptyAllowedNote", async () => {
  const ticket = mkTicket("hole-finder-cost", "low");
  const providers = mkProviders({ reasoning: { style: "openai", allowed: [] } });
  await assert.rejects(
    resolveSpokes(ticket, providers, process.cwd(), "zh", () => true, () => true, undefined),
    (err: unknown) => {
      assert.equal(
        (err as DispatchError).message,
        m("zh", "effortNotAllowed", "hole-finder-cost", "low", "testprovider", m("zh", "emptyAllowedNote")),
      );
      return true;
    },
  );
});

// modelNotWhitelisted [agent, model, provider, list]：4 個同型參數，手寫字面量斷言（hub 裁決：
// 實測把這裡的 zh 版 ${model}／${provider} 對調，全用 m() 重建的舊版測試 17 pass／0 fail，
// 一條都沒紅——這正是本輪要補的洞）。
test("resolveSpokes：models 白名單非空且 model 不在其中 → 中止，訊息依 lang（zh／en，手寫字面量）", async () => {
  const ticket = mkTicket("hole-finder-cost", "low", "not-whitelisted-model");
  const providers = mkProviders({ models: ["model-a", "model-b"] });
  await assert.rejects(
    resolveSpokes(ticket, providers, process.cwd(), "zh", () => true, () => true, undefined),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(
        err.message,
        '"hole-finder-cost" 列的 model "not-whitelisted-model" 不在 provider "testprovider" 的 models 白名單內（允許：model-a, model-b）',
      );
      return true;
    },
  );
  await assert.rejects(
    resolveSpokes(ticket, providers, process.cwd(), "en", () => true, () => true, undefined),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(
        err.message,
        'The "hole-finder-cost" row\'s model "not-whitelisted-model" is not in provider "testprovider"\'s models whitelist (allowed: model-a, model-b)',
      );
      return true;
    },
  );
});

// providerUndefinedInRow [agent, provider]：2 個同型參數，手寫字面量斷言（hub 裁決）。
test("resolveSpokes：provider 未定義於 providers.json → 中止，訊息依 lang（zh／en，手寫字面量）", async () => {
  const ticket = mkTicket("hole-finder-cost", "low");
  ticket.rows[0].provider = "unknown-provider";
  await assert.rejects(
    resolveSpokes(ticket, mkProviders(), process.cwd(), "zh", () => true, () => true, undefined),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(
        err.message,
        '_dispatch.md 的 "hole-finder-cost" 列引用了未定義於 providers.json 的 provider "unknown-provider"',
      );
      return true;
    },
  );
  await assert.rejects(
    resolveSpokes(ticket, mkProviders(), process.cwd(), "en", () => true, () => true, undefined),
    (err: unknown) => {
      assert.equal(
        (err as DispatchError).message,
        '_dispatch.md\'s "hole-finder-cost" row references provider "unknown-provider", which is not defined in providers.json',
      );
      return true;
    },
  );
});

// apiKeyNotConfigured [agent, provider, cmd]：3 個同型參數，手寫字面量斷言（hub 裁決）
// ——綁訊息鍵抓不到參數順序錯置，而這三個都是字串。
//
// 0.5.0 起這道檢查問的是 hasApiKey 回呼（DB），不再讀 process.env，所以本測試也不再
// 動環境變數：直接傳一個回 false 的回呼。
test("resolveSpokes：provider 沒有 API key → 中止，訊息依 lang（zh／en，手寫字面量）", async () => {
  const ticket = mkTicket("hole-finder-cost", "low");
  const providers = mkProviders();
  await assert.rejects(
    resolveSpokes(ticket, providers, process.cwd(), "zh", () => true, () => false, undefined),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(
        err.message,
        '尚未設定 provider "testprovider" 的 API key（"hole-finder-cost" 列需要它）。\n'
          + "  本版的 API key 已併入資料庫設定，不再讀取 .env 或環境變數；請執行 `dowafu key` 設定。",
      );
      return true;
    },
  );
  await assert.rejects(
    resolveSpokes(ticket, providers, process.cwd(), "en", () => true, () => false, undefined),
    (err: unknown) => {
      assert.equal(
        (err as DispatchError).message,
        'No API key configured for provider "testprovider" (the "hole-finder-cost" row needs one).\n'
          + "  This version keeps API keys in the database and no longer reads .env or environment variables; run `dowafu key` to set one.",
      );
      return true;
    },
  );
});

// loadTicket() 正常路徑下必為 perAgent 命中——這是型別窄化用的防禦分支，手動構造一份
// rows 與 perAgent 不一致的 Ticket 才能觸發，藉此覆蓋這則訊息。
test("resolveSpokes：內部錯誤——rows 引用的 agent 不在 perAgent 內 → 中止，訊息依 lang（zh／en）", async () => {
  const ticket: Ticket = {
    ticketDir: "tmp/dispatch/fake-ticket-for-validate-test",
    rows: [{ agent: "hole-finder-cost", provider: "testprovider", model: "model-a", effort: "low" }],
    shared: { premises: [], reviewText: "待審段落", strayHeadings: [] },
    perAgent: new Map(),
  };
  await assert.rejects(
    resolveSpokes(ticket, mkProviders(), process.cwd(), "zh", () => true, () => true, undefined),
    (err: unknown) => {
      assert.ok(err instanceof DispatchError);
      assert.equal(err.message, m("zh", "internalErrorTicketContentMissing", "hole-finder-cost"));
      return true;
    },
  );
  await assert.rejects(
    resolveSpokes(ticket, mkProviders(), process.cwd(), "en", () => true, () => true, undefined),
    (err: unknown) => {
      assert.equal((err as DispatchError).message, m("en", "internalErrorTicketContentMissing", "hole-finder-cost"));
      return true;
    },
  );
});

// readAgentBody（validate.ts 私有）由 resolveSpokes 穿透 lang——這則的觸發條件是
// .claude/agents/<agent>.md 不存在，用一個沒有該 agent 定義檔的假 repoRoot 觸發。
// agentDefNotFound [path, agent]：2 個同型參數，手寫字面量斷言（hub 裁決；path 為臨時目錄
// 動態路徑，用 JS 模板字面量插入——結構仍是手寫的，不是呼叫 m()）。
test("resolveSpokes：agent 定義檔不存在 → 中止，訊息依 lang（zh／en，手寫字面量）", async () => {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), "dispatch-repo-root-"));
  try {
    mkdirSync(path.join(repoRoot, ".claude", "agents"), { recursive: true });
    const ticket = mkTicket("hole-finder-cost", "low");
    const agentDefPath = path.join(repoRoot, ".claude", "agents", "hole-finder-cost.md");
    await assert.rejects(
      resolveSpokes(ticket, mkProviders(), repoRoot, "zh", () => true, () => true, undefined),
      (err: unknown) => {
        assert.ok(err instanceof DispatchError);
        assert.equal(err.message, `找不到 agent 定義檔 ${agentDefPath}（_dispatch.md 列了 "hole-finder-cost"）`);
        return true;
      },
    );
    await assert.rejects(
      resolveSpokes(ticket, mkProviders(), repoRoot, "en", () => true, () => true, undefined),
      (err: unknown) => {
        assert.equal(
          (err as DispatchError).message,
          `Agent definition file not found: ${agentDefPath} (_dispatch.md lists "hole-finder-cost")`,
        );
        return true;
      },
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("resolveSpokes：models 白名單非空且 model 在其中 → 通過", async () => {
  const ticket = mkTicket("hole-finder-cost", "low", "model-b");
  const providers = mkProviders({ models: ["model-a", "model-b"] });
  const spokes = await resolveSpokes(ticket, providers, process.cwd(), "zh", () => true, () => true, undefined);
  assert.equal(spokes[0].model, "model-b");
});

test("resolveSpokes：disabled model 在派工時被擋，exit code 與找不到型號不同", async () => {
  const ticket = mkTicket("hole-finder-cost", "low", "model-a");
  await assert.rejects(resolveSpokes(ticket, mkProviders(), process.cwd(), "zh", () => false, () => true, undefined), (err: unknown) => {
    assert.ok(err instanceof DispatchError);
    assert.equal(err.exitCode, 6);
    assert.match(err.message, /providers enable model-a/);
    return true;
  });
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
    const spokes = await resolveSpokes(ticket, mkProviders(), repoRoot, "zh", () => true, () => true, undefined);
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
      shared: { premises: [], reviewText: "待審段落", strayHeadings: [] },
      perAgent: new Map([["hole-finder-cost", { questions: "具體問題", allowedReads: ["allowed.txt"] }]]),
    };
    const spokes = await resolveSpokes(ticket, mkProviders(), repoRoot, "zh", () => true, () => true, undefined);
    assert.equal(spokes[0].allowedReadsResolved.length, 1);
    assert.match(spokes[0].allowedReadsResolved[0], /allowed\.txt$/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("D1：DB 工單快照缺少允許檔時即使磁碟同名檔存在仍中止，不得回退讀磁碟", async () => {
  const repoRoot = mkFakeRepoRoot();
  try {
    const ticket: Ticket = {
      ticketDir: "ticket/snapshot-only",
      ticketName: "snapshot-only",
      rows: [{ agent: "hole-finder-cost", provider: "testprovider", model: "model-a", effort: "low" }],
      shared: { premises: [], reviewText: "待審段落", strayHeadings: [] },
      perAgent: new Map([["hole-finder-cost", { questions: "具體問題", allowedReads: ["allowed.txt"] }]]),
      // Deliberately omit allowed.txt while retaining the ticket documents. The file exists
      // on disk from mkFakeRepoRoot, so a fallback would turn this test green incorrectly.
      allowedContent: new Map([
        ["ticket/snapshot-only/_shared.md", "shared snapshot"],
        ["ticket/snapshot-only/hole-finder-cost.md", "agent ticket snapshot"],
      ]),
    };
    await assert.rejects(
      resolveSpokes(ticket, mkProviders(), repoRoot, "en", () => true, () => true, undefined),
      (err: unknown) => err instanceof DispatchError && err.message === m("en", "allowedReadsPathNotFound", "hole-finder-cost", "allowed.txt"),
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// allowedReadsUnderDocs [agent, rel]：2 個同型參數，手寫字面量斷言（hub 裁決）。
test("resolveSpokes：_docs/ 拒絕判定相對 --repo-root，不是相對 process.cwd()，訊息依 lang（zh／en，手寫字面量）", async () => {
  const repoRoot = mkFakeRepoRoot();
  try {
    const ticket: Ticket = {
      ticketDir: "tmp/dispatch/fake-ticket-for-validate-test",
      rows: [{ agent: "hole-finder-cost", provider: "testprovider", model: "model-a", effort: "low" }],
      shared: { premises: [], reviewText: "待審段落", strayHeadings: [] },
      perAgent: new Map([["hole-finder-cost", { questions: "具體問題", allowedReads: ["_docs/secret.md"] }]]),
    };
    await assert.rejects(
      resolveSpokes(ticket, mkProviders(), repoRoot, "zh", () => true, () => true, undefined),
      (err: unknown) => {
        assert.ok(err instanceof DispatchError);
        assert.equal(err.message, '"hole-finder-cost" 的允許讀取清單指向 _docs/（spoke 禁區）：_docs/secret.md');
        return true;
      },
    );
    await assert.rejects(
      resolveSpokes(ticket, mkProviders(), repoRoot, "en", () => true, () => true, undefined),
      (err: unknown) => {
        assert.equal(
          (err as DispatchError).message,
          'The "hole-finder-cost" allowed-reads list points into _docs/ (a spoke-restricted area): _docs/secret.md',
        );
        return true;
      },
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// allowedReadsPathNotFound [agent, rel]：2 個同型參數，手寫字面量斷言（hub 裁決）。
test("resolveSpokes：允許讀取清單指向不存在的路徑 → 中止，訊息依 lang（zh／en，手寫字面量）", async () => {
  const repoRoot = mkFakeRepoRoot();
  try {
    const ticket: Ticket = {
      ticketDir: "tmp/dispatch/fake-ticket-for-validate-test",
      rows: [{ agent: "hole-finder-cost", provider: "testprovider", model: "model-a", effort: "low" }],
      shared: { premises: [], reviewText: "待審段落", strayHeadings: [] },
      perAgent: new Map([["hole-finder-cost", { questions: "具體問題", allowedReads: ["does-not-exist.txt"] }]]),
    };
    await assert.rejects(
      resolveSpokes(ticket, mkProviders(), repoRoot, "zh", () => true, () => true, undefined),
      (err: unknown) => {
        assert.ok(err instanceof DispatchError);
        assert.equal(err.message, '"hole-finder-cost" 的允許讀取清單指向不存在的路徑：does-not-exist.txt');
        return true;
      },
    );
    await assert.rejects(
      resolveSpokes(ticket, mkProviders(), repoRoot, "en", () => true, () => true, undefined),
      (err: unknown) => {
        assert.equal(
          (err as DispatchError).message,
          'The "hole-finder-cost" allowed-reads list points to a path that does not exist: does-not-exist.txt',
        );
        return true;
      },
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
