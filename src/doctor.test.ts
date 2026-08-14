import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDoctorReport, type DoctorProbe, type DoctorProvidersResult } from "./doctor.js";
import { m } from "./messages.js";
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
  const probe: DoctorProbe = { fileExists: (p) => p === "/explicit/home/.env", readDir: () => null };
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

test("buildDoctorReport：lens 目錄存在 → 算所有 hole-finder 開頭的，含無後綴的 hole-finder.md；explore-haiku 不算", () => {
  const probe: DoctorProbe = {
    fileExists: () => false,
    readDir: (p) => (p === "/proj/.claude/agents" ? ["hole-finder.md", "hole-finder-cost.md", "explore-haiku.md"] : null),
  };
  const report = buildDoctorReport("en", "dowafu", FAKE_PROVIDERS, {}, () => "/home/testuser", probe, "/proj");
  const line = lineStartingWith(report, "  Lens defs");
  assert.equal(
    line,
    m(
      "en",
      "doctorLensLine",
      m("en", "doctorLensFoundValue", "/proj/.claude/agents", 2, "hole-finder, hole-finder-cost"),
    ),
  );
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
