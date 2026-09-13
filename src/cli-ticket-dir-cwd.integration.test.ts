// ticket-dir-cwd（log_v0_6_0_open.md #31）：CLI 直呼、cwd ≠ --repo-root 時，DB 工單的 spoke
// 讀不讀得到工單檔。實跑撞到時稽核全綠——付了錢、拿到一份沒看過規劃書的審查。
//
// 為什麼要另開這一檔：既有三條測試都在「對的條件」下跑，卻都繞開了「spoke 照 prompt 給的路徑
// 去讀」這一步——乾跑測試走的是未 resolve 的路徑、進度測試的假 provider 一輪就交卷、runner 的
// 快照測試讀的是寫死的路徑。所以這裡的假模型**只照第一則使用者訊息去讀**（步驟 1、2 的
// read_file("…")，加上步驟 3 逐條列出的路徑），不寫死任何路徑（工單不變量 7）。
//
// ⚠️ 環境：假 provider 必須 spawn 成獨立子行程，不可在測試行程裡 createServer
// （見 cli-progress.integration.test.ts 檔頭）。
// CLI 用 `node --import <tsx 的絕對 URL>` 起：cwd 刻意不在本 repo，裸的 `--import tsx` 或
// `npx tsx` 都從 cwd 找 tsx——本機沒有全域 tsx，npx 找不到時可能去連 registry。
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { addAllow, addSpoke, createTicket, sealTicket } from "./ticket-store.js";
import { setProviderKey } from "./provider-key.js";
import { mergeProviders, readProvidersFile, setModelEnabled } from "./providers-store.js";

const CLI_ENTRY = fileURLToPath(new URL("./cli.ts", import.meta.url));
const TSX_LOADER = import.meta.resolve("tsx");

const TICKET = "sample";
const AGENT = "hole-finder-cost";
const ALLOWED_REL = "src/allowed.ts";
// 三份內容各帶一個可辨識的標記：spoke 收到的必須逐字是 DB 存的那份，不是某個佔位符或拒絕訊息。
const SHARED = "# 待審段落\nshared-marker-7f3a：待審內容\n";
const BODY = `# 具體問題\n1. body-marker-91c2 問題\n\n# 允許讀取\n- ${ALLOWED_REL}\n`;
const ALLOWED = "export const allowedMarker = 'allowed-marker-2b8d';\n";
const SEALED_AGENT_BODY = "sealed-agent-marker-72d9";

// 假的 Responses API。每個請求原樣記進 capture 檔（「provider 實際收到什麼」以它為準，不靠 CLI
// 自己落 DB 的那份）。還沒有 function_call_output 的請求 → 從第一則使用者訊息抽路徑、回 tool call；
// 拿到工具結果後 → 回最終答案。
const FAKE_SERVER = `
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
const [portPath, capturePath] = process.argv.slice(2);
const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
function reply(res, output) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "resp_fake", object: "response", created_at: 0, model: "fake-model", status: "completed", output, usage }));
}
const FINAL = "# Observations\\n1. done\\n\\n# Cannot verify\\n- none\\n\\nThese are observations and questions. Whether to adopt them is for the hub and the user to decide.";
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const body = JSON.parse(raw);
    appendFileSync(capturePath, JSON.stringify(body) + "\\n");
    const input = body.input ?? [];
    if (input.some((item) => item.type === "function_call_output")) {
      reply(res, [{ type: "message", id: "msg_final", role: "assistant", status: "completed",
                    content: [{ type: "output_text", text: FINAL, annotations: [] }] }]);
      return;
    }
    const firstUser = input.find((item) => item.role === "user");
    const text = firstUser.content.map((c) => c.text).join("");
    const paths = [...text.matchAll(/read_file\\("([^"]+)"\\)/g)].map((m) => m[1]);
    for (const line of text.split("\\n")) {
      const listed = /^   - (.+)$/.exec(line);
      if (listed) paths.push(listed[1]);
    }
    reply(res, paths.map((p, i) => ({ type: "function_call", id: "fc_" + i, call_id: "call_" + i, name: "read_file",
                                     arguments: JSON.stringify({ path: p }), status: "completed" })));
  });
});
server.listen(0, "127.0.0.1", () => { writeFileSync(portPath, String(server.address().port)); });
`;

const PROVIDERS = (port: number) => ({
  formatVersion: 1,
  fake: {
    baseURL: `http://127.0.0.1:${port}/v1`,
    api: "responses",
    store: false,
    toolCalling: true,
    reasoning: { style: "openai", allowed: ["low"], default: "low" },
    models: ["fake-model"],
    charsPerToken: 1.0,
    tpmLimit: null,
    maxSpokeTokens: null,
    pricing: { "fake-model": { inputPerM: 0.1, outputPerM: 0.2 } },
  },
});

type Layout = { root: string; repoRoot: string; elsewhere: string; subdir: string; home: string };

type CapturedRequest = {
  instructions: string;
  input: Array<{ type?: string; role?: string; content?: Array<{ text: string }>; call_id?: string; output?: string }>;
};

type PersistedResult = {
  toolCalls: Array<{ path: string; allowed: boolean; reason?: string }>;
  estimatedPromptTokens: number;
};

type Outcome = {
  code: number | null;
  stdout: string;
  stderr: string;
  requests: CapturedRequest[];
  result: PersistedResult | null;
  planEstimatedTokens: number | null;
};

function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", TSX_LOADER, CLI_ENTRY, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function startFakeProvider(root: string): Promise<{ port: number; capturePath: string; stop: () => void }> {
  const scriptPath = path.join(root, "fake-provider.mjs");
  const portPath = path.join(root, "port.txt");
  const capturePath = path.join(root, "requests.jsonl");
  writeFileSync(scriptPath, FAKE_SERVER);
  const child: ChildProcess = spawn(process.execPath, [scriptPath, portPath, capturePath], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    if (existsSync(portPath)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!existsSync(portPath)) {
    child.kill();
    throw new Error("假 provider 沒有在 5 秒內啟動");
  }
  return { port: Number(readFileSync(portPath, "utf8")), capturePath, stop: () => child.kill() };
}

// realpath：macOS 的 tmpdir 是 symlink（/var → /private/var），子行程的 process.cwd() 會拿到解析後
// 的那條。不先解析的話，「cwd = --repo-root」這一格在字串上其實不相等，測到的就不是它宣稱的組合。
function makeLayout(): Layout {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "cli-ticket-dir-cwd-")));
  const layout = {
    root,
    repoRoot: path.join(root, "repo"),
    elsewhere: path.join(root, "elsewhere"),
    subdir: path.join(root, "repo", "sub"),
    home: path.join(root, "home"),
  };
  for (const dir of [layout.elsewhere, layout.subdir, layout.home, path.join(layout.repoRoot, ".claude", "agents"), path.join(layout.repoRoot, "src")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path.join(layout.repoRoot, ".claude", "agents", `${AGENT}.md`), SEALED_AGENT_BODY);
  writeFileSync(path.join(layout.repoRoot, ALLOWED_REL), ALLOWED);
  return layout;
}

async function dispatchFrom(layout: Layout, cwd: string): Promise<Outcome> {
  const provider = await startFakeProvider(layout.root);
  try {
    const providersPath = path.join(layout.home, "providers.json");
    writeFileSync(providersPath, JSON.stringify(PROVIDERS(provider.port)));
    const dbPath = path.join(layout.home, "dowafu.db");
    const db = openDb(dbPath, "en");
    try {
      mergeProviders(db, await readProvidersFile(providersPath, "en"), false);
      setModelEnabled(db, "fake", "fake-model", true, "en");
      setProviderKey(db, "fake", "test-key-abc123xyz");
      createTicket(db, TICKET, SHARED, "zh");
      addSpoke(db, TICKET, { agent: AGENT, provider: "fake", model: "fake-model", body: BODY }, "zh");
      await addAllow(db, TICKET, AGENT, ALLOWED_REL, layout.repoRoot, "zh");
      await sealTicket(db, TICKET, layout.repoRoot, "zh");
      // A sealed ticket must not observe this replacement, even when execution starts
      // from elsewhere (the first CASE is cwd !== repoRoot).
      writeFileSync(path.join(layout.repoRoot, ".claude", "agents", `${AGENT}.md`), "disk-replacement-must-not-appear");
    } finally {
      db.close();
    }

    const run = await runCli(
      [TICKET, "--db", dbPath, "--repo-root", layout.repoRoot, "--yes", "--json"],
      cwd,
      { ...process.env, DISPATCH_HOME: layout.home, DISPATCH_LANG: "en" },
    );

    const requests: CapturedRequest[] = existsSync(provider.capturePath)
      ? readFileSync(provider.capturePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as CapturedRequest)
      : [];

    const check = openDb(dbPath, "en");
    let result: PersistedResult | null = null;
    try {
      const row = check.prepare("SELECT response FROM results WHERE job_id = ? AND agent = ?").get(TICKET, AGENT) as { response: string } | undefined;
      if (row) result = (JSON.parse(row.response) as { result: PersistedResult }).result;
    } finally {
      check.close();
    }

    let planEstimatedTokens: number | null = null;
    try {
      const payload = JSON.parse(run.stdout.trim()) as { plan: Array<{ agent: string; estimatedTokens: number }> };
      planEstimatedTokens = payload.plan.find((entry) => entry.agent === AGENT)?.estimatedTokens ?? null;
    } catch {
      // 留 null，由斷言帶著 stdout／stderr 報出來
    }

    return { ...run, requests, result, planEstimatedTokens };
  } finally {
    provider.stop();
  }
}

function describeRun(outcome: Outcome): string {
  return `exit=${outcome.code}\nstderr：${outcome.stderr}\nstdout：${outcome.stdout}`;
}

function firstUserText(request: CapturedRequest): string {
  const user = request.input.find((item) => item.role === "user");
  return (user?.content ?? []).map((c) => c.text).join("");
}

const CASES: Array<{ title: string; cwdOf: (layout: Layout) => string }> = [
  { title: "cwd 在 --repo-root 之外（#31 實跑撞到的組合）", cwdOf: (layout) => layout.elsewhere },
  { title: "cwd 是 --repo-root 的子目錄", cwdOf: (layout) => layout.subdir },
  { title: "cwd = --repo-root（不變量 2：行為不變）", cwdOf: (layout) => layout.repoRoot },
];

for (const c of CASES) {
  describe(`ticket-dir-cwd：${c.title}`, () => {
    let layout: Layout;
    let outcome: Outcome;

    before(async () => {
      layout = makeLayout();
      outcome = await dispatchFrom(layout, c.cwdOf(layout));
    });

    after(() => {
      rmSync(layout.root, { recursive: true, force: true });
    });

    test("spoke 照第一則訊息給的路徑讀：工單兩檔與允許清單全部 allowed，收到的逐字是 DB 存的內容", () => {
      assert.equal(outcome.code, 0, describeRun(outcome));
      assert.ok(outcome.result, `DB 裡應有這支 spoke 的結果\n${describeRun(outcome)}`);
      assert.equal(outcome.result.toolCalls.length, 3, `應讀 _shared.md、${AGENT}.md 與 ${ALLOWED_REL} 三檔：${JSON.stringify(outcome.result.toolCalls)}`);
      const rejected = outcome.result.toolCalls.filter((call) => !call.allowed);
      assert.deepEqual(rejected, [], `不得有任何讀取被拒——被拒正是 #31 的症狀：${JSON.stringify(outcome.result.toolCalls)}`);

      assert.equal(outcome.requests.length, 2, `provider 應收到兩個請求（讀檔、交卷）\n${describeRun(outcome)}`);
      assert.match(outcome.requests[0].instructions, new RegExp(SEALED_AGENT_BODY));
      assert.doesNotMatch(outcome.requests[0].instructions, /disk-replacement-must-not-appear/);
      const outputs = outcome.requests[1].input
        .filter((item) => item.type === "function_call_output")
        .map((item) => item.output ?? "");
      assert.deepEqual([...outputs].sort(), [SHARED, BODY, ALLOWED].sort(), "spoke 收到的必須逐字是 DB 存的 shared／body／允許檔內容");
    });

    // 不變量 3：乾跑估算（cli.ts）與實跑（runSpoke）的第一則訊息必須同源。一次實跑裡兩邊都有證據：
    // `--json` 的 plan 是乾跑那條路算的估算；provider 收到的 instructions＋第一則訊息是實跑真正送出的。
    // charsPerToken 為 1.0，估算即字元數，兩則文字只要有一點不同就對不上。
    test("乾跑估算的第一則訊息，就是實跑真正送給 provider 的那一則（不變量 3）", () => {
      assert.equal(outcome.code, 0, describeRun(outcome));
      assert.ok(outcome.requests.length >= 1, `provider 應至少收到一個請求\n${describeRun(outcome)}`);
      assert.notEqual(outcome.planEstimatedTokens, null, `--json 的 plan 應有這支 spoke 的估算\n${describeRun(outcome)}`);
      const sent = outcome.requests[0];
      const sentChars = sent.instructions.length + firstUserText(sent).length;
      assert.equal(outcome.planEstimatedTokens, sentChars, "乾跑估算與實際送出的 system prompt＋第一則訊息長度不一致——兩條路又分岔了");
      assert.equal(outcome.result?.estimatedPromptTokens, sentChars, "runSpoke 自己記的估算也必須與實際送出的一致");
    });
  });
}
