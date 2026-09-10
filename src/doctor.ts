// 工單 W1（fix_batch_4）§一：`dowafu --doctor`——零素材、零成本的設定自檢。
//
// 組字串的純函式，依賴（env／homedir／檔案探針）比照 dispatch-home.ts 的做法以參數注入，
// 皆有指向真實環境的預設值——cli.ts 只需 `buildDoctorReport(lang, cmd, providersResult)`
// 就能在正式環境跑，doctor.test.ts 則能整組覆寫、不碰真實家目錄。
//
// providers.json 的載入是唯一沒有走這條注入路徑的資料來源：那段是既有的 loadProviders／
// bundledProvidersPath（async，且已有自己的驗證與錯誤訊息），改由 cli.ts 在呼叫本檔之前
// 先 await 好、包成 DoctorProvidersResult 傳進來——本檔本體維持同步、純函式。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDispatchHome } from "./dispatch-home.js";
import { lensClosingLineStatus } from "./report.js";
import { m } from "./messages.js";
import type { Lang, ProvidersFile } from "./types.js";
import type { StoredModel } from "./providers-store.js";
import type { DaemonLiveness } from "./liveness.js";
import type { KeyStatusRow } from "./provider-key.js";
import type { JobQueueCounts } from "./job.js";

export interface DoctorProbe {
  fileExists: (p: string) => boolean;
  // 目錄不存在回傳 null；存在則回傳其下的檔名清單（不遞迴）。
  readDir: (p: string) => string[] | null;
  // 工單 X1 v1.1 §三：讀不到（不存在、權限不足、非文字檔等）一律回 null——lens 偵測要
  // 判定收尾句需要檔案內文，先前只有 fileExists／readDir，拿不到內容。
  readFile: (p: string) => string | null;
}

const DEFAULT_PROBE: DoctorProbe = {
  fileExists: (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  },
  readDir: (p) => {
    try {
      return fs.readdirSync(p);
    } catch {
      return null;
    }
  },
  readFile: (p) => {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
};

export type DoctorProvidersResult = { ok: true; providers: ProvidersFile; models: StoredModel[] } | { ok: false; reason: string };

export type DoctorReportData = {
  configDir: { source: "dispatch_home" | "xdg_config_home" | "default"; path: string } | { source: "unresolved" };
  dbPath?: string;
  envFilePresent: boolean;
  apiKeys: KeyStatusRow[];
  models:
    | { ok: true; enabled: number; total: number; mostExpensive: { provider: string; model: string; outputPerM: number } | null }
    | { ok: false; reason: string };
  daemon: DaemonLiveness;
  // Keep this camelCase shape stable: dowafu-hanma reads it from --doctor --json.
  queue: JobQueueCounts;
  lenses: { found: true; dirPath: string; withClosing: string[]; withoutClosing: string[] } | { found: false; dirPath: string };
};

// 工單 key-db §B-3 #6：逐 provider 印出實際生效的是哪一層，不是只印 process.env 的 ✓／✗。
// keyStatusRows 由 cli.ts 呼叫 provider-key.ts 的 buildKeyStatusRows() 算好傳進來——
// 本檔維持同步、純函式（見檔頭「providers.json 的載入是唯一沒有走這條注入路徑」的慣例，
// DB 也一樣不在本檔內讀取）。
function buildApiKeyValue(lang: Lang, rows: KeyStatusRow[]): string {
  if (rows.length === 0) return m(lang, "doctorApiKeySourceMissing");
  return rows
    .map((row) => {
      const name = row.provider.toUpperCase();
      const status =
        row.maskedTail === null
          ? m(lang, "doctorApiKeySourceMissing")
          : m(lang, "doctorApiKeySourceDb", row.maskedTail, row.updatedAt ? row.updatedAt.slice(0, 10) : "") +
            (row.lastTestSucceeded === null || row.lastTestedAt === null || row.lastTestModel === null
              ? m(lang, "keyStatusUntested")
              : m(
                  lang,
                  row.lastTestSucceeded ? "keyStatusTestSucceeded" : "keyStatusTestFailed",
                  row.lastTestModel,
                  row.lastTestedAt.slice(0, 10),
                ));
      return m(lang, "doctorApiKeyRow", name, status);
    })
    .join("  ");
}

function buildDaemonValue(lang: Lang, daemon: DaemonLiveness | undefined): string {
  if (daemon?.alive) return m(lang, "doctorDaemonAlive", daemon.pid);
  return m(lang, "doctorDaemonMissing", daemon?.reason ?? "heartbeat_missing");
}

function buildQueueValue(lang: Lang, queue: JobQueueCounts): string {
  return m(lang, "doctorQueueValue", queue.pendingApproval, queue.approved, queue.running);
}

function buildConfigDirValue(lang: Lang, configDir: DoctorReportData["configDir"]): string {
  if (configDir.source === "unresolved") return m(lang, "doctorConfigDirUnresolved");
  if (configDir.source === "dispatch_home") return m(lang, "doctorConfigDirSourceDispatchHome", configDir.path);
  if (configDir.source === "xdg_config_home") return m(lang, "doctorConfigDirSourceXdgConfigHome", configDir.path);
  return m(lang, "doctorConfigDirSourceDefault", configDir.path);
}

// A（gaps #2）：本版根本不讀 `.env`，所以「這個檔不存在」不是一則診斷，是雜訊——它讀起來
// 像「你少了這個檔」。**只有檔案真的在的時候才印那一行**，措辭沿用既有的「有，但本版不讀取」
// ——那句對從 0.4.x 升上來、家目錄還躺著舊 `.env` 的人正好是需要的提醒。
// 回傳 null 代表整行不印（不是印一行「沒有」）。
function buildModelListValue(lang: Lang, models: DoctorReportData["models"]): string {
  if (!models.ok) return m(lang, "doctorModelListLoadFailedValue", models.reason);
  const name = models.mostExpensive
    ? `${models.mostExpensive.provider}/${models.mostExpensive.model} ($${models.mostExpensive.outputPerM}/M)`
    : m(lang, "noneLabel");
  return m(lang, "doctorModelListValue", models.enabled, models.total, name);
}

// 工單 X1 v1.1 §三：doctor 不再只認 `hole-finder` 這個名字——只裝 translation-* 一類 lens
// 的專案先前會被回報 0 個，使用者會誤以為裝錯了。改列出 `.claude/agents/` 底下所有 `.md`，
// 並依「檔案內文最後一句是不是固定收尾句」分成兩組（判定沿用 report.ts 的
// lensClosingLineStatus，不在此重寫）。沒有收尾句不是錯誤——`explore-haiku.md` 就是這種。
function buildLensData(probe: DoctorProbe, cwd: string): DoctorReportData["lenses"] {
  const dirPath = path.join(cwd, ".claude", "agents");
  const entries = probe.readDir(dirPath);
  if (entries === null) return { found: false, dirPath };
  const withClosing: string[] = [];
  const withoutClosing: string[] = [];
  for (const file of entries.filter((f) => f.endsWith(".md"))) {
    const name = file.slice(0, -".md".length);
    const content = probe.readFile(path.join(dirPath, file));
    // 讀不到內容（不存在於這一刻、權限不足…）不得讓整支 doctor 失敗——歸入無收尾句一組。
    // 取捨：輸出上這與「確實沒有收尾句」分不出來，讀者看到的都是「無收尾句」；工單允許
    // 「無法判定」或「無收尾句」二選一，這裡選後者，不是宣稱「照實說」出兩者的差異。
    const status = content !== null ? lensClosingLineStatus(content) : "none";
    (status === "none" ? withoutClosing : withClosing).push(name);
  }
  withClosing.sort();
  withoutClosing.sort();
  return { found: true, dirPath, withClosing, withoutClosing };
}

function buildLensValue(lang: Lang, lenses: DoctorReportData["lenses"]): string {
  if (!lenses.found) return m(lang, "doctorLensDirMissingValue", lenses.dirPath);
  const joiner = lang === "zh" ? "、" : ", ";
  const noClosingSuffix = lenses.withoutClosing.length > 0 ? m(lang, "doctorLensNoClosingSuffix", lenses.withoutClosing.length, lenses.withoutClosing.join(joiner)) : "";
  const closingNames = lenses.withClosing.length > 0 ? lenses.withClosing.join(joiner) : m(lang, "noneLabel");
  return m(lang, "doctorLensFoundValue", lenses.dirPath, lenses.withClosing.length + lenses.withoutClosing.length, lenses.withClosing.length, closingNames, noClosingSuffix);
}

export function buildDoctorReportData(
  cmd: string,
  providers: DoctorProvidersResult,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
  probe: DoctorProbe = DEFAULT_PROBE,
  cwd: string = process.cwd(),
  daemon?: DaemonLiveness,
  keyStatusRows: KeyStatusRow[] = [],
  dbPath?: string,
  queue: JobQueueCounts = { pendingApproval: 0, approved: 0, running: 0 },
): DoctorReportData {
  const dispatchHome = resolveDispatchHome(env, homedir);
  const configDir =
    dispatchHome === null
      ? ({ source: "unresolved" } as const)
      : env.DISPATCH_HOME
        ? ({ source: "dispatch_home", path: dispatchHome } as const)
        : env.XDG_CONFIG_HOME
          ? ({ source: "xdg_config_home", path: dispatchHome } as const)
          : ({ source: "default", path: dispatchHome } as const);
  const models = !providers.ok
    ? ({ ok: false, reason: providers.reason } as const)
    : (() => {
        const enabled = providers.models.filter((model) => model.enabled);
        const mostExpensive = enabled.filter((model) => model.outputPerM !== undefined).sort((a, b) => (b.outputPerM ?? 0) - (a.outputPerM ?? 0))[0];
        return {
          ok: true as const,
          enabled: enabled.length,
          total: providers.models.length,
          mostExpensive: mostExpensive && mostExpensive.outputPerM !== undefined
            ? { provider: mostExpensive.provider, model: mostExpensive.model, outputPerM: mostExpensive.outputPerM }
            : null,
        };
      })();
  // cmd remains part of the human presentation header, not a diagnostic observation.
  void cmd;
  return {
    configDir,
    ...(dbPath ? { dbPath } : {}),
    envFilePresent: dispatchHome !== null && probe.fileExists(path.join(dispatchHome, ".env")),
    apiKeys: keyStatusRows.map((row) => ({ ...row })),
    models,
    daemon: daemon ?? { alive: false, reason: "heartbeat_missing" },
    queue: { ...queue },
    lenses: buildLensData(probe, cwd),
  };
}

export function renderDoctorReport(lang: Lang, cmd: string, data: DoctorReportData): string {
  const lines = [
    m(lang, "doctorHeader", cmd),
    m(lang, "doctorConfigDirLine", buildConfigDirValue(lang, data.configDir)),
    // A（gaps #1）：這一行印的是**這次真的會用到的** DB 檔——`--db` 帶了就是它。
    // 先前 doctor 寫死走預設 DB，於是 `--doctor --db <別的>` 會對著另一個資料庫回答你。
    ...(data.dbPath ? [m(lang, "doctorDbLine", data.dbPath)] : []),
    ...(data.envFilePresent ? [m(lang, "doctorEnvLine", m(lang, "doctorEnvPresentValue"))] : []),
    m(lang, "doctorApiKeyLine", buildApiKeyValue(lang, data.apiKeys)),
    m(lang, "doctorModelListLine", buildModelListValue(lang, data.models)),
    m(lang, "doctorDaemonLine", buildDaemonValue(lang, data.daemon)),
    m(lang, "doctorQueueLine", buildQueueValue(lang, data.queue)),
    m(lang, "doctorLensLine", buildLensValue(lang, data.lenses)),
    "",
    m(lang, "doctorFooter"),
  ];
  return lines.join("\n");
}

export function buildDoctorReport(
  lang: Lang,
  cmd: string,
  providers: DoctorProvidersResult,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
  probe: DoctorProbe = DEFAULT_PROBE,
  cwd: string = process.cwd(),
  daemon?: DaemonLiveness,
  keyStatusRows: KeyStatusRow[] = [],
  dbPath?: string,
  queue: JobQueueCounts = { pendingApproval: 0, approved: 0, running: 0 },
): string {
  return renderDoctorReport(lang, cmd, buildDoctorReportData(cmd, providers, env, homedir, probe, cwd, daemon, keyStatusRows, dbPath, queue));
}
