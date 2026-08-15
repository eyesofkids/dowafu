import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildDoctorReport, type DoctorProbe, type DoctorProvidersResult } from "./doctor.js";
import { m } from "./messages.js";
import { FIXED_CLOSING_LINE, FIXED_CLOSING_LINE_EN } from "./audit.js";
import type { ProviderConfig } from "./types.js";

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

// ②key 全有／全無／混合三種情況的 ✓✗ 排列

test("buildDoctorReport：API key 全無 → 四項皆 ✗，不省略整行", () => {
  const report = buildDoctorReport("en", "dowafu", FAKE_PROVIDERS, {}, () => "/home/testuser", noProbe(), "/cwd");
  const line = lineStartingWith(report, "  API keys");
  assert.match(line, /DEEPSEEK ✗ {2}GEMINI ✗ {2}OPENAI ✗ {2}ANTHROPIC ✗/);
});

test("buildDoctorReport：API key 全有 → 四項皆 ✓", () => {
  const env = {
    DEEPSEEK_API_KEY: "x",
    GEMINI_API_KEY: "x",
    OPENAI_API_KEY: "x",
    ANTHROPIC_API_KEY: "x",
  };
  const report = buildDoctorReport("en", "dowafu", FAKE_PROVIDERS, env, () => "/home/testuser", noProbe(), "/cwd");
  const line = lineStartingWith(report, "  API keys");
  assert.match(line, /DEEPSEEK ✓ {2}GEMINI ✓ {2}OPENAI ✓ {2}ANTHROPIC ✓/);
});

test("buildDoctorReport：API key 混合有無 → 逐項對應各自的 ✓／✗", () => {
  const env = { DEEPSEEK_API_KEY: "x", OPENAI_API_KEY: "x" };
  const report = buildDoctorReport("en", "dowafu", FAKE_PROVIDERS, env, () => "/home/testuser", noProbe(), "/cwd");
  const line = lineStartingWith(report, "  API keys");
  assert.match(line, /DEEPSEEK ✓ {2}GEMINI ✗ {2}OPENAI ✓ {2}ANTHROPIC ✗/);
});

test("buildDoctorReport：API key 不印值也不印片段（長度、前後綴皆不行）", () => {
  const env = { DEEPSEEK_API_KEY: "sk-super-secret-value-should-never-leak" };
  const report = buildDoctorReport("en", "dowafu", FAKE_PROVIDERS, env, () => "/home/testuser", noProbe(), "/cwd");
  assert.doesNotMatch(report, /sk-super-secret/);
  assert.doesNotMatch(report, /super-secret-value-should-never-leak/);
});

// ③.env 不存在時的字

test("buildDoctorReport：.env 不存在 → 印沒有＋完整路徑", () => {
  const report = buildDoctorReport(
    "en",
    "dowafu",
    FAKE_PROVIDERS,
    { DISPATCH_HOME: "/explicit/home" },
    () => "/home/testuser",
    noProbe(),
    "/cwd",
  );
  const line = lineStartingWith(report, "  .env");
  assert.equal(
    line,
    m("en", "doctorEnvLine", m("en", "doctorEnvMissingValue", "/explicit/home/.env")),
  );
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
  assert.match(block, /1 more without a closing line: explore-haiku/);
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
  const report = buildDoctorReport("zh", "dowafu", FAKE_PROVIDERS, {}, () => "/home/testuser", noProbe(), "/cwd");
  assert.equal(
    lineStartingWith(report, "  設定目錄"),
    m("zh", "doctorConfigDirLine", m("zh", "doctorConfigDirSourceDefault", "/home/testuser/.config/dowafu")),
  );
  assert.match(lineStartingWith(report, "  API key"), /DEEPSEEK ✗ {2}GEMINI ✗ {2}OPENAI ✗ {2}ANTHROPIC ✗/);
});
