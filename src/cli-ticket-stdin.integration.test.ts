// 工單 status-stdin §B 的**接線**測試。ticket-store.ts 的 createTicket／addSpoke 本來就吃
// 字串，這裡驗的是 CLI 這一層：`-` 代表從 stdin 讀本文，兩個子指令用同一種表達方式、
// 讀出來的內容與既有的路徑寫法逐字相同。
//
// 不變量 10（stdin 是 TTY 卻要求讀 stdin）用 macOS 內建的 `script -q /dev/null` 給子行程
// 一個真的 pty——spawn 的預設 stdio 是管道，isTTY 恆為 false，不會走到守衛那個分支；
// 自動化環境沒有辦法用 node-pty 之類的原生模組（未列入依賴），`script` 是唯一不需要額外
// 依賴、在 macOS 上可靠可行的做法。測試本身用 node:test 的 `timeout` 選項界定上限（不是
// shell 的 timeout／gtimeout——那個工具在 macOS 上不存在，是 gtimeout；工單變異 8 的警告
// 指的是不要用它來偵測「會不會卡住」，node:test 自己的 timeout 是測試框架機制，不是同一件
// 事）：守衛正確時這個測試在毫秒等級完成，守衛被拿掉（變異 8）時會真的卡住，直到 node:test
// 判定逾時、測試失敗——這就是「驗守衛本身有作用」。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { m } from "./messages.js";
import { getTicketDoc } from "./ticket-store.js";

const CLI_ENTRY = fileURLToPath(new URL("./cli.ts", import.meta.url));

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", CLI_ENTRY, ...args], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runCliWithStdin(args: string[], env: NodeJS.ProcessEnv, stdinContent: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", CLI_ENTRY, ...args], { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdinContent, "utf8");
  });
}

function withRoot(run: (root: string, dbPath: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "cli-ticket-stdin-"));
  const dbPath = path.join(root, "dowafu.db");
  return run(root, dbPath).finally(() => rmSync(root, { recursive: true, force: true }));
}

const SHARED_CONTENT = "# 待審段落\n內容裡有 - 這個符號，不是 stdin 旗標\n";
const BODY_CONTENT = "# 具體問題\n1. 問題\n\n# 允許讀取\n";

test("CLI：key 的非 TTY 說明不再引導環境變數，且與缺 key 的 DB 單一來源立場一致", () => {
  const en = m("en", "keyInteractiveRequiresTty");
  const zh = m("zh", "keyInteractiveRequiresTty");
  assert.match(en, /Run dowafu key in an interactive terminal/);
  assert.match(zh, /在互動式終端機執行 dowafu key/);
  assert.doesNotMatch(en, /environment variable|OPENAI_API_KEY/i);
  assert.doesNotMatch(zh, /環境變數|OPENAI_API_KEY/);
  assert.match(m("en", "apiKeyNotConfigured", "agent", "provider", "dowafu"), /no longer reads .env or environment variables/);
  assert.notEqual(en, zh, "兩種語言不可固定回英文");
});

// 不變量 7／變異 6（§B 的主要防線）：用 stdin 建出來的工單，DB 內容與「先寫檔再用路徑建」
// 逐字相同——「stdin 那條路讀不到就傳空字串」這種假實作會被這條抓到。
test("CLI：ticket create 用 - 從 stdin 讀本文，DB 內容與路徑寫法逐字相同", async () => {
  await withRoot(async (root, dbPath) => {
    const sharedPath = path.join(root, "shared.md");
    writeFileSync(sharedPath, SHARED_CONTENT);
    const env = { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "en" };

    const viaPath = await runCli(["ticket", "create", "via-path", sharedPath, "--db", dbPath], env);
    assert.equal(viaPath.code, 0, `路徑寫法應成功；stderr：${viaPath.stderr}`);

    const viaStdin = await runCliWithStdin(["ticket", "create", "via-stdin", "-", "--db", dbPath], env, SHARED_CONTENT);
    assert.equal(viaStdin.code, 0, `stdin 寫法應成功；stderr：${viaStdin.stderr}`);

    const db = openDb(dbPath, "en");
    try {
      const fromPath = getTicketDoc(db, "via-path", "en");
      const fromStdin = getTicketDoc(db, "via-stdin", "en");
      assert.equal(fromStdin.shared, SHARED_CONTENT);
      assert.equal(fromStdin.shared, fromPath.shared, "stdin 與路徑寫法的 DB 內容必須逐字相同");
    } finally {
      db.close();
    }
  });
});

test("CLI：ticket add-spoke 用 - 從 stdin 讀本文，DB 內容與路徑寫法逐字相同", async () => {
  await withRoot(async (root, dbPath) => {
    const sharedPath = path.join(root, "shared.md");
    const bodyPath = path.join(root, "body.md");
    writeFileSync(sharedPath, SHARED_CONTENT);
    writeFileSync(bodyPath, BODY_CONTENT);
    const env = { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "en" };

    assert.equal((await runCli(["ticket", "create", "t", sharedPath, "--db", dbPath], env)).code, 0);

    const viaPath = await runCli(["ticket", "add-spoke", "t", "hole-finder-cost", "deepseek", "deepseek-v4-flash", bodyPath, "--db", dbPath], env);
    assert.equal(viaPath.code, 0, `路徑寫法應成功；stderr：${viaPath.stderr}`);

    const viaStdin = await runCliWithStdin(
      ["ticket", "add-spoke", "t", "hole-finder-feasibility", "deepseek", "deepseek-v4-flash", "-", "--db", dbPath],
      env,
      BODY_CONTENT,
    );
    assert.equal(viaStdin.code, 0, `stdin 寫法應成功；stderr：${viaStdin.stderr}`);

    const db = openDb(dbPath, "en");
    try {
      const doc = getTicketDoc(db, "t", "en");
      const fromPath = doc.spokes.find((s) => s.agent === "hole-finder-cost");
      const fromStdin = doc.spokes.find((s) => s.agent === "hole-finder-feasibility");
      assert.ok(fromPath && fromStdin);
      assert.equal(fromStdin!.body, BODY_CONTENT);
      assert.equal(fromStdin!.body, fromPath!.body, "stdin 與路徑寫法的 DB 內容必須逐字相同");
    } finally {
      db.close();
    }
  });
});

// 不變量 9／變異 7：add-spoke 用 stdin 時，[effort] 這個選用的位置參數排在 <body-file>
// 之後——用 "-" 佔住 body-file 的位置，位置索引完全不變，effort 給與不給都要正確解析。
test("CLI：ticket add-spoke 用 stdin 時，[effort] 給與不給都正確解析", async () => {
  await withRoot(async (root, dbPath) => {
    const sharedPath = path.join(root, "shared.md");
    writeFileSync(sharedPath, SHARED_CONTENT);
    const env = { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "en" };
    assert.equal((await runCli(["ticket", "create", "t", sharedPath, "--db", dbPath], env)).code, 0);

    const withEffort = await runCliWithStdin(
      ["ticket", "add-spoke", "t", "with-effort", "deepseek", "deepseek-v4-flash", "-", "high", "--db", dbPath],
      env,
      BODY_CONTENT,
    );
    assert.equal(withEffort.code, 0, `帶 effort 應成功；stderr：${withEffort.stderr}`);

    const withoutEffort = await runCliWithStdin(
      ["ticket", "add-spoke", "t", "without-effort", "deepseek", "deepseek-v4-flash", "-", "--db", dbPath],
      env,
      BODY_CONTENT,
    );
    assert.equal(withoutEffort.code, 0, `不帶 effort 應成功；stderr：${withoutEffort.stderr}`);

    const db = openDb(dbPath, "en");
    try {
      const doc = getTicketDoc(db, "t", "en");
      assert.equal(doc.spokes.find((s) => s.agent === "with-effort")?.effort, "high");
      assert.equal(doc.spokes.find((s) => s.agent === "without-effort")?.effort, undefined);
    } finally {
      db.close();
    }
  });
});

// 不變量 8：既有的路徑用法完全不變——用既有的接線測試（cli-providers-seed.integration.test.ts）
// 已經鎖住這件事；這裡只額外確認本票新增的 stdin 分支不影響同一個 ticket 內既有的路徑寫法
// 繼續可用（create 與 add-spoke 混用兩種表達方式）。
test("CLI：同一個工單內混用路徑寫法與 stdin 寫法互不影響", async () => {
  await withRoot(async (root, dbPath) => {
    const sharedPath = path.join(root, "shared.md");
    const bodyPath = path.join(root, "body.md");
    writeFileSync(sharedPath, SHARED_CONTENT);
    writeFileSync(bodyPath, BODY_CONTENT);
    const env = { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "en" };

    assert.equal((await runCliWithStdin(["ticket", "create", "mixed", "-", "--db", dbPath], env, SHARED_CONTENT)).code, 0);
    const added = await runCli(["ticket", "add-spoke", "mixed", "hole-finder-cost", "deepseek", "deepseek-v4-flash", bodyPath, "--db", dbPath], env);
    assert.equal(added.code, 0, `stdin 建的工單，路徑寫法加 spoke 應照常成功；stderr：${added.stderr}`);
  });
});

// 不變量 11：ticketHelp 中英兩套都說明新用法。
test("CLI：ticket --help 的用法說明中英兩套都提到 - 代表從 stdin 讀本文", async () => {
  await withRoot(async (root, dbPath) => {
    const en = await runCli(["ticket", "--help", "--db", dbPath], { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "en" });
    assert.equal(en.code, 0);
    assert.equal(en.stdout.trimEnd(), m("en", "ticketHelp", "dowafu"));
    assert.match(en.stdout, /stdin/i);

    const zh = await runCli(["ticket", "--help", "--db", dbPath], { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "zh-tw" });
    assert.equal(zh.code, 0);
    assert.equal(zh.stdout.trimEnd(), m("zh", "ticketHelp", "dowafu"));
    assert.match(zh.stdout, /stdin/);
  });
});

// 不變量 10／變異 8（§B 的主要防線）：stdin 是 TTY（沒有東西被導進來）卻要求讀 stdin，
// 必須講人話並以非零 exit 中止，不能掛住等鍵盤輸入。見檔頭說明：用 `script -q /dev/null`
// 給子行程一個真的 pty，用 node:test 自己的 timeout 界定上限，不靠 shell 的 timeout。
test("CLI：ticket create - 在 stdin 是 TTY 時講人話並以非零 exit 中止，不卡住", { timeout: 15_000 }, async () => {
  await withRoot(async (root, dbPath) => {
    const child = spawn(
      "script",
      ["-q", "/dev/null", "npx", "tsx", CLI_ENTRY, "ticket", "create", "tty-test", "-", "--db", dbPath],
      {
        cwd: process.cwd(),
        env: { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: "en" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let combined = "";
    child.stdout.on("data", (c: Buffer) => { combined += c.toString(); });
    child.stderr.on("data", (c: Buffer) => { combined += c.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.notEqual(code, 0, `stdin 是 TTY 時應以非零 exit 中止；輸出：${combined}`);
    assert.match(combined, /interactive terminal/i, `應講人話說明 stdin 是互動式終端機；輸出：${combined}`);
  });
});
