import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildDoctorReport, buildDoctorReportData, renderDoctorReport, type DoctorProbe, type DoctorProvidersResult } from "./doctor.js";
import { m } from "./messages.js";
import { FIXED_CLOSING_LINE, FIXED_CLOSING_LINE_EN } from "./audit.js";
import type { ProviderConfig } from "./types.js";
import type { KeyStatusRow } from "./provider-key.js";
import type { DaemonLiveness } from "./liveness.js";

// 工單 W1（fix_batch_4）§一之8：注入假的 env／homedir／檔案探針，驗四類案例。
// **不驗完整輸出的逐字快照**——那會讓之後每次改字都紅，只斷言會變的那一行。

function fakeProvider(models: string[]): ProviderConfig {
  return {
    baseURL: "https://example.invalid",
    api: "responses",
    store: false,
    toolCalling: true,
    reasoning: { style: null, allowed: [] },
    models,
    charsPerToken: null,
    tpmLimit: null,
    maxSpokeTokens: null,
  };
}

const FAKE_PROVIDERS: DoctorProvidersResult = {
  ok: true,
  providers: {
    openai: fakeProvider(["a", "b", "c"]),
    deepseek: fakeProvider(["a", "b"]),
  },
  models: [
    { provider: "openai", model: "a", inputPerM: 1, cachedInputPerM: undefined, cacheWritePerM: undefined, outputPerM: 2, enabled: true },
    { provider: "openai", model: "b", inputPerM: 1, cachedInputPerM: undefined, cacheWritePerM: undefined, outputPerM: 3, enabled: false },
    { provider: "openai", model: "c", inputPerM: 1, cachedInputPerM: undefined, cacheWritePerM: undefined, outputPerM: 4, enabled: false },
    { provider: "deepseek", model: "a", inputPerM: 1, cachedInputPerM: undefined, cacheWritePerM: undefined, outputPerM: 5, enabled: false },
    { provider: "deepseek", model: "b", inputPerM: 1, cachedInputPerM: undefined, cacheWritePerM: undefined, outputPerM: 6, enabled: false },
  ],
};

function noProbe(): DoctorProbe {
  return {
    fileExists: () => false,
    readDir: () => null,
    readFile: () => null,
  };
}

function lineStartingWith(report: string, prefix: string): string {
  const line = report.split("\n").find((l) => l.startsWith(prefix));
  assert.ok(line, `no line starting with ${JSON.stringify(prefix)} in:\n${report}`);
  return line as string;
}

// ①三種設定目錄來源各印對應字串

test("buildDoctorReport：設定目錄來源——明設 DISPATCH_HOME", () => {
  const report = buildDoctorReport(
    "en",
    "dowafu",
    FAKE_PROVIDERS,
    { DISPATCH_HOME: "/explicit/home" },
    () => "/home/testuser",
    noProbe(),
    "/some/cwd",
  );
  const line = lineStartingWith(report, "  Config dir");
  assert.equal(line, m("en", "doctorConfigDirLine", m("en", "doctorConfigDirSourceDispatchHome", "/explicit/home")));
});

test("buildDoctorReport：設定目錄來源——XDG_CONFIG_HOME", () => {
  const report = buildDoctorReport(
    "en",
    "dowafu",
    FAKE_PROVIDERS,
    { XDG_CONFIG_HOME: "/xdg" },
    () => "/home/testuser",
    noProbe(),
    "/some/cwd",
  );
  const line = lineStartingWith(report, "  Config dir");
  const expectedDir = "/xdg/dowafu";
  assert.equal(
    line,
    m("en", "doctorConfigDirLine", m("en", "doctorConfigDirSourceXdgConfigHome", expectedDir)),
  );
});

test("buildDoctorReport：設定目錄來源——兩者皆未設，走預設", () => {
  const report = buildDoctorReport("en", "dowafu", FAKE_PROVIDERS, {}, () => "/home/testuser", noProbe(), "/some/cwd");
  const line = lineStartingWith(report, "  Config dir");
  const expectedDir = "/home/testuser/.config/dowafu";
  assert.equal(line, m("en", "doctorConfigDirLine", m("en", "doctorConfigDirSourceDefault", expectedDir)));
});

test("buildDoctorReport：homedir() 拋錯（無 HOME）→ 印無法解析，不拋出", () => {
  const report = buildDoctorReport(
    "en",
    "dowafu",
    FAKE_PROVIDERS,
    {},
    () => {
      throw new Error("no passwd entry");
    },
    noProbe(),
    "/some/cwd",
  );
  const line = lineStartingWith(report, "  Config dir");
  assert.equal(line, m("en", "doctorConfigDirLine", m("en", "doctorConfigDirUnresolved")));
});

// ②key 全有／全無／混合三種情況——工單 key-db §B-3 #6：改為逐 provider 印「哪一層生效」
// （DB／env／未設定），不再是 process.env 的單純 ✓／✗。keyStatusRows 由 cli.ts 算好傳入，
// 這裡直接建假資料，不碰真實 DB。

const ALL_MISSING_ROWS: KeyStatusRow[] = ["deepseek", "gemini", "openai", "anthropic"].map((provider) => ({
  provider,
  maskedTail: null,
  updatedAt: null,
  lastTestedAt: null,
  lastTestModel: null,
  lastTestSucceeded: null,
}));

test("buildDoctorReport：API key 全無 → 四項皆未設定，不省略任何一項", () => {
  const report = buildDoctorReport("en", "dowafu", FAKE_PROVIDERS, {}, () => "/home/testuser", noProbe(), "/cwd", undefined, ALL_MISSING_ROWS);
  const line = lineStartingWith(report, "  API keys");
  for (const provider of ["DEEPSEEK", "GEMINI", "OPENAI", "ANTHROPIC"]) {
    assert.match(line, new RegExp(`${provider} ${m("en", "doctorApiKeySourceMissing")}`));
  }
});

test("buildDoctorReport：API key 全部來自 DB → 逐項印遮罩尾碼與日期", () => {
  const rows: KeyStatusRow[] = [
    { provider: "deepseek", maskedTail: "…aaaa", updatedAt: "2026-09-01T00:00:00.000Z", lastTestedAt: null, lastTestModel: null, lastTestSucceeded: null },
    { provider: "openai", maskedTail: "…bbbb", updatedAt: "2026-09-02T00:00:00.000Z", lastTestedAt: null, lastTestModel: null, lastTestSucceeded: null },
  ];
  const report = buildDoctorReport("en", "dowafu", FAKE_PROVIDERS, {}, () => "/home/testuser", noProbe(), "/cwd", undefined, rows);
  const line = lineStartingWith(report, "  API keys");
  assert.match(line, /DEEPSEEK DB \(…aaaa, 2026-09-01\)/);
  assert.match(line, /OPENAI DB \(…bbbb, 2026-09-02\)/);
});

// 0.5.0 起 DB 是唯一來源，所以逐項只有「已設定／未設定」兩種，沒有來源要對應。
test("buildDoctorReport：部分 provider 有 key、部分沒有 → 逐項各自顯示", () => {
  const rows: KeyStatusRow[] = [
    { provider: "deepseek", maskedTail: "…aaaa", updatedAt: "2026-09-01T00:00:00.000Z", lastTestedAt: null, lastTestModel: null, lastTestSucceeded: null },
    { provider: "openai", maskedTail: null, updatedAt: null, lastTestedAt: null, lastTestModel: null, lastTestSucceeded: null },
    { provider: "gemini", maskedTail: "…cccc", updatedAt: "2026-08-01T00:00:00.000Z", lastTestedAt: null, lastTestModel: null, lastTestSucceeded: null },
    { provider: "anthropic", maskedTail: null, updatedAt: null, lastTestedAt: null, lastTestModel: null, lastTestSucceeded: null },
  ];
  const report = buildDoctorReport("en", "dowafu", FAKE_PROVIDERS, {}, () => "/home/testuser", noProbe(), "/cwd", undefined, rows);
  const line = lineStartingWith(report, "  API keys");
  assert.match(line, /DEEPSEEK DB \(…aaaa, 2026-09-01\)/);
  assert.match(line, /GEMINI DB \(…cccc, 2026-08-01\)/);
  assert.match(line, /OPENAI not set/);
  assert.match(line, /ANTHROPIC not set/);
});

test("buildDoctorReport：不印任何明文或原始 env 值，即使 env 裡真的放著長得像 key 的字串", () => {
  const env = { OPENAI_API_KEY: "sk-super-secret-value-should-never-leak" };
  const rows: KeyStatusRow[] = [{ provider: "openai", maskedTail: null, updatedAt: null, lastTestedAt: null, lastTestModel: null, lastTestSucceeded: null }];
  const report = buildDoctorReport("en", "dowafu", FAKE_PROVIDERS, env, () => "/home/testuser", noProbe(), "/cwd", undefined, rows);
  assert.doesNotMatch(report, /sk-super-secret/);
  assert.doesNotMatch(report, /super-secret-value-should-never-leak/);
});

// ③.env 的行只在檔案真的存在時才印

// A（gaps #2）：本版根本不讀 `.env`，所以「這個檔不存在」不是診斷是雜訊——它讀起來像
// 「你少了這個檔」。整行不印，而不是印一行「沒有」。
test("buildDoctorReport：.env 不存在 → 整行不出現", () => {
  const report = buildDoctorReport(
    "en",
    "dowafu",
    FAKE_PROVIDERS,
    { DISPATCH_HOME: "/explicit/home" },
    () => "/home/testuser",
    noProbe(),
    "/cwd",
  );
  // lineStartingWith 找不到時是拋錯不是回 undefined，所以這裡直接驗整份報表。
  assert.equal(report.split("\n").filter((line) => line.startsWith("  .env")).length, 0);
  assert.doesNotMatch(report, /\.env/);
});

// A（gaps #1）：doctor 要印出這次真的會用到的 DB 檔——金鑰／工單／結果全在那個檔裡，
// 而先前整份報表從頭到尾沒印過它。
test("buildDoctorReport：印出傳入的 DB 路徑", () => {
  const report = buildDoctorReport(
    "en",
    "dowafu",
    FAKE_PROVIDERS,
    { DISPATCH_HOME: "/explicit/home" },
    () => "/home/testuser",
    noProbe(),
    "/cwd",
    undefined,
    [],
    "/somewhere/else/other.db",
  );
  assert.equal(lineStartingWith(report, "  Database"), m("en", "doctorDbLine", "/somewhere/else/other.db"));
});

test("buildDoctorReport：.env 存在 → 印有（不讀內容）", () => {
  const probe: DoctorProbe = { fileExists: (p) => p === "/explicit/home/.env", readDir: () => null, readFile: () => null };
  const report = buildDoctorReport(
    "en",
    "dowafu",
    FAKE_PROVIDERS,
    { DISPATCH_HOME: "/explicit/home" },
    () => "/home/testuser",
    probe,
    "/cwd",
  );
  const line = lineStartingWith(report, "  .env");
  assert.equal(line, m("en", "doctorEnvLine", m("en", "doctorEnvPresentValue")));
});

// ④lens 目錄不存在時不被寫成錯誤

test("buildDoctorReport：lens 目錄不存在 → 印目錄不存在＋路徑，措辭不是錯誤", () => {
  const report = buildDoctorReport("en", "dowafu", FAKE_PROVIDERS, {}, () => "/home/testuser", noProbe(), "/some/project");
  const line = lineStartingWith(report, "  Lens defs");
  const expectedDir = "/some/project/.claude/agents";
  assert.equal(line, m("en", "doctorLensLine", m("en", "doctorLensDirMissingValue", expectedDir)));
  assert.doesNotMatch(line, /error|Error|失敗|錯誤/);
});

test("buildDoctorReport：daemon 存活態明列 pid，離線態不可假裝成功", () => {
  const alive = buildDoctorReport("en", "dowafu", FAKE_PROVIDERS, {}, () => "/home/testuser", noProbe(), "/cwd", { alive: true, pid: 42 });
  assert.equal(lineStartingWith(alive, "  Daemon"), m("en", "doctorDaemonLine", m("en", "doctorDaemonAlive", 42)));
  const offline = buildDoctorReport("en", "dowafu", FAKE_PROVIDERS, {}, () => "/home/testuser", noProbe(), "/cwd", { alive: false, reason: "heartbeat_stale" });
  assert.equal(lineStartingWith(offline, "  Daemon"), m("en", "doctorDaemonLine", m("en", "doctorDaemonMissing", "heartbeat_stale")));
});

// 工單 X1 v1.1 §三：doctor 的 lens 偵測不再綁 hole-finder 這個名字——列出目錄下所有 .md，
// 依「檔案內文最後一句是不是固定收尾句」（report.ts 的 lensClosingLineStatus，非重寫）分成
// 兩組。readFile 依檔名回傳內容，null 代表讀不到（歸入無收尾句一組，不得讓 doctor 失敗）。
function mkLensProbe(dirPath: string, files: Record<string, string | null>): DoctorProbe {
  return {
    fileExists: () => false,
    readDir: (p) => (p === dirPath ? Object.keys(files) : null),
    readFile: (p) => {
      for (const [name, content] of Object.entries(files)) {
        if (p === path.join(dirPath, name)) return content;
      }
      return null;
    },
  };
}

// doctorLensFoundValue 現在是三段式，值本身含 "\n" 續行（總數行 ＋ 有收尾句清單 ＋ 無收尾句
// 一段）——既有的 lineStartingWith 只抓「起始於這個 prefix 的那一行」，抓不到續行。這裡另開
// 一個區塊版本：從起始行開始，收集到下一個空行為止（buildDoctorReport 的 lines 陣列裡，
// lens 這格後面一定接一個 "" 再接 footer）。既有的 lineStartingWith 不動，供其餘單行案例用。
function lensBlock(report: string, prefix: string): string {
  const lines = report.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith(prefix));
  assert.ok(startIdx >= 0, `no line starting with ${JSON.stringify(prefix)} in:\n${report}`);
  const block = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length && lines[i] !== ""; i++) block.push(lines[i]);
  return block.join("\n");
}

test("buildDoctorReport：目錄含 translation-*.md（有收尾句）→ 要被列出", () => {
  const dir = "/proj/.claude/agents";
  const probe = mkLensProbe(dir, {
    "translation-fidelity.md": `some body\n\n${FIXED_CLOSING_LINE}`,
    "translation-register.md": `some body\n\n${FIXED_CLOSING_LINE_EN}`,
  });
  const report = buildDoctorReport("en", "dowafu", FAKE_PROVIDERS, {}, () => "/home/testuser", probe, "/proj");
  const block = lensBlock(report, "  Lens defs");
  assert.equal(
    block,
    m(
      "en",
      "doctorLensLine",
      m("en", "doctorLensFoundValue", dir, 2, 2, "translation-fidelity, translation-register", ""),
    ),
  );
});

test("buildDoctorReport：目錄完全沒有 hole-finder* → 仍列出實際檔案，不得回報 0", () => {
  const dir = "/proj/.claude/agents";
  const probe = mkLensProbe(dir, {
    "translation-fidelity.md": `some body\n\n${FIXED_CLOSING_LINE}`,
    "foo.md": "沒有固定收尾句的一般內文",
  });
  const report = buildDoctorReport("en", "dowafu", FAKE_PROVIDERS, {}, () => "/home/testuser", probe, "/proj");
  const block = lensBlock(report, "  Lens defs");
  assert.doesNotMatch(block, /holds 0 definition/, "v1.0 綁死 hole-finder 名稱的舊行為：只裝非 hole-finder lens 時回報 0");
  assert.equal(
    block,
    m(
      "en",
      "doctorLensLine",
      m(
        "en",
        "doctorLensFoundValue",
        dir,
        2,
        1,
        "translation-fidelity",
        m("en", "doctorLensNoClosingSuffix", 1, "foo"),
      ),
    ),
  );
});

test("buildDoctorReport：explore-haiku.md（無收尾句）列在「無收尾句」那一組，不是錯誤", () => {
  const dir = "/proj/.claude/agents";
  const probe = mkLensProbe(dir, {
    "hole-finder.md": `body\n\n${FIXED_CLOSING_LINE}`,
    "explore-haiku.md": "你是快速探索 codebase 的 sub-agent，不做修改、不下判斷、不提建議。",
  });
  const report = buildDoctorReport("en", "dowafu", FAKE_PROVIDERS, {}, () => "/home/testuser", probe, "/proj");
  const block = lensBlock(report, "  Lens defs");
  assert.equal(
    block,
    m(
      "en",
      "doctorLensLine",
      m(
        "en",
        "doctorLensFoundValue",
        dir,
        2,
        1,
        "hole-finder",
        m("en", "doctorLensNoClosingSuffix", 1, "explore-haiku"),
      ),
    ),
  );
  assert.doesNotMatch(block, /error|Error|失敗|錯誤/);
});

// 讀不到某個檔的內容（探針回 null）不得讓整支 doctor 失敗——歸入無收尾句一組，照實說。
test("buildDoctorReport：readFile 回 null（讀不到內容）→ 該檔歸入無收尾句一組，不拋錯", () => {
  const dir = "/proj/.claude/agents";
  const probe = mkLensProbe(dir, {
    "hole-finder.md": `body\n\n${FIXED_CLOSING_LINE}`,
    "unreadable.md": null,
  });
  assert.doesNotThrow(() => {
    const report = buildDoctorReport("en", "dowafu", FAKE_PROVIDERS, {}, () => "/home/testuser", probe, "/proj");
    const block = lensBlock(report, "  Lens defs");
    assert.equal(
      block,
      m(
        "en",
        "doctorLensLine",
        m(
          "en",
          "doctorLensFoundValue",
          dir,
          2,
          1,
          "hole-finder",
          m("en", "doctorLensNoClosingSuffix", 1, "unreadable"),
        ),
      ),
    );
  });
});

// 回歸：本 repo 的實際 .claude/agents 目錄（DEFAULT_PROBE／真實 cwd）——四支 hole-finder
// 仍在，總數正確。這是 v1.0 只認 hole-finder 這個名字時就已經覆蓋的情境，v1.1 不得倒退。
test("buildDoctorReport：回歸——本 repo 實際目錄跑 --doctor，四支 hole-finder 仍在、總數正確", () => {
  const report = buildDoctorReport("en", "dowafu", FAKE_PROVIDERS);
  const block = lensBlock(report, "  Lens defs");
  assert.match(block, /holds 5 definition file\(s\), 4 with a fixed closing line/);
  for (const agent of ["hole-finder", "hole-finder-cost", "hole-finder-feasibility", "hole-finder-safety"]) {
    assert.match(block, new RegExp(`(?<![\\w-])${agent}(?![\\w-])`), `應列出 ${agent}`);
  }
  // 熱修補（2026-08-15）：排序基準是「去掉 .md 的名字」，不是檔名——否則 '-'(45) < '.'(46)
  // 會讓無後綴的 hole-finder 排到 hole-finder-cost 之後，看起來像被降級。
  assert.match(block, /hole-finder, hole-finder-cost, hole-finder-feasibility, hole-finder-safety/);
  // e2e_fixes ⑤（log 的 E4）：explore-haiku 不是 lens 而是 Claude Code 的探索 sub-agent，
  // 舊措辭「無收尾句」把它講成一個不完整的 lens，實測誘導 agent 誤讀。
  assert.match(block, /1 other agent file\(s\), not lenses: explore-haiku/);
});

// 額外：providers 載入失敗時印失敗原因、不中止（buildDoctorReport 本身不拋）

test("buildDoctorReport：providers 載入失敗 → 印失敗原因，函式本身不拋", () => {
  const failed: DoctorProvidersResult = { ok: false, reason: "boom" };
  assert.doesNotThrow(() => {
    const report = buildDoctorReport("en", "dowafu", failed, {}, () => "/home/testuser", noProbe(), "/cwd");
    const line = lineStartingWith(report, "  Model list");
    assert.equal(line, m("en", "doctorModelListLine", m("en", "doctorModelListLoadFailedValue", "boom")));
  });
});

// zh 版同一組行為的抽樣覆核（不逐字比對整份報告，只比對會變的那幾行）

test("buildDoctorReport：zh 語言下的設定目錄與 API key 行", () => {
  const report = buildDoctorReport("zh", "dowafu", FAKE_PROVIDERS, {}, () => "/home/testuser", noProbe(), "/cwd", undefined, ALL_MISSING_ROWS);
  assert.equal(
    lineStartingWith(report, "  設定目錄"),
    m("zh", "doctorConfigDirLine", m("zh", "doctorConfigDirSourceDefault", "/home/testuser/.config/dowafu")),
  );
  const line = lineStartingWith(report, "  API key");
  for (const provider of ["DEEPSEEK", "GEMINI", "OPENAI", "ANTHROPIC"]) {
    assert.match(line, new RegExp(`${provider} ${m("zh", "doctorApiKeySourceMissing")}`));
  }
});

test("doctor JSON 與人類版共用同一判定，且 JSON 只帶遮罩 key 尾碼與 daemon 三態", () => {
  const rawKey = "sk-super-secret-value-should-never-leak";
  const rows: KeyStatusRow[] = [{ provider: "openai", maskedTail: "…leak", updatedAt: "2026-09-08T00:00:00.000Z", lastTestedAt: null, lastTestModel: null, lastTestSucceeded: null }];
  for (const daemon of [
    { alive: false, reason: "heartbeat_missing" as const },
    { alive: false, reason: "heartbeat_stale" as const },
    { alive: false, reason: "pid_gone" as const },
  ] satisfies DaemonLiveness[]) {
    const data = buildDoctorReportData("dowafu", FAKE_PROVIDERS, { OPENAI_API_KEY: rawKey }, () => "/home/testuser", noProbe(), "/cwd", daemon, rows, "/tmp/dowafu.db");
    const json = JSON.stringify(data);
    const human = renderDoctorReport("en", "dowafu", data);
    assert.equal(data.daemon, daemon, "JSON 與文字版必須讀同一個 daemon 判定物件");
    assert.match(json, new RegExp(daemon.reason));
    assert.match(human, new RegExp(daemon.reason));
    assert.match(json, /…leak/);
    assert.doesNotMatch(json, new RegExp(rawKey));
    assert.doesNotMatch(human, new RegExp(rawKey));
  }
});
