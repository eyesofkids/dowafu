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
import { SECRET_ENV_VARS } from "./secret-env.js";
import { PROVIDERS_FORMAT_VERSION } from "./providers.js";
import { lensClosingLineStatus } from "./report.js";
import { m } from "./messages.js";
import type { Lang, ProvidersFile } from "./types.js";

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

export type DoctorProvidersResult = { ok: true; providers: ProvidersFile } | { ok: false; reason: string };

function buildConfigDirValue(lang: Lang, env: NodeJS.ProcessEnv, dispatchHome: string | null): string {
  if (dispatchHome === null) return m(lang, "doctorConfigDirUnresolved");
  if (env.DISPATCH_HOME) return m(lang, "doctorConfigDirSourceDispatchHome", dispatchHome);
  if (env.XDG_CONFIG_HOME) return m(lang, "doctorConfigDirSourceXdgConfigHome", dispatchHome);
  return m(lang, "doctorConfigDirSourceDefault", dispatchHome);
}

function buildEnvValue(lang: Lang, probe: DoctorProbe, dispatchHome: string | null): string {
  if (dispatchHome === null) return m(lang, "doctorEnvUnresolvedValue");
  const envPath = path.join(dispatchHome, ".env");
  return probe.fileExists(envPath) ? m(lang, "doctorEnvPresentValue") : m(lang, "doctorEnvMissingValue", envPath);
}

function buildModelListValue(lang: Lang, providers: DoctorProvidersResult): string {
  if (!providers.ok) return m(lang, "doctorModelListLoadFailedValue", providers.reason);
  const joiner = lang === "zh" ? "、" : ", ";
  const items = Object.entries(providers.providers)
    .map(([name, config]) => m(lang, "doctorProviderCountItem", name, config.models.length))
    .join(joiner);
  return m(lang, "doctorModelListValue", PROVIDERS_FORMAT_VERSION, items);
}

// 工單 X1 v1.1 §三：doctor 不再只認 `hole-finder` 這個名字——只裝 translation-* 一類 lens
// 的專案先前會被回報 0 個，使用者會誤以為裝錯了。改列出 `.claude/agents/` 底下所有 `.md`，
// 並依「檔案內文最後一句是不是固定收尾句」分成兩組（判定沿用 report.ts 的
// lensClosingLineStatus，不在此重寫）。沒有收尾句不是錯誤——`explore-haiku.md` 就是這種。
function buildLensValue(lang: Lang, probe: DoctorProbe, cwd: string): string {
  const lensDir = path.join(cwd, ".claude", "agents");
  const entries = probe.readDir(lensDir);
  if (entries === null) return m(lang, "doctorLensDirMissingValue", lensDir);
  const joiner = lang === "zh" ? "、" : ", ";
  const mdFiles = entries.filter((f) => f.endsWith(".md"));

  const withClosing: string[] = [];
  const withoutClosing: string[] = [];
  for (const file of mdFiles) {
    const name = file.slice(0, -".md".length);
    const content = probe.readFile(path.join(lensDir, file));
    // 讀不到內容（不存在於這一刻、權限不足…）不得讓整支 doctor 失敗——歸入無收尾句一組。
    // 取捨：輸出上這與「確實沒有收尾句」分不出來，讀者看到的都是「無收尾句」；工單允許
    // 「無法判定」或「無收尾句」二選一，這裡選後者，不是宣稱「照實說」出兩者的差異。
    const status = content !== null ? lensClosingLineStatus(content) : "none";
    (status === "none" ? withoutClosing : withClosing).push(name);
  }
  // 熱修補（2026-08-15）：對「去掉 .md 的名字」排序，不是對檔名排序——'-'(45) < '.'(46)，
  // 對檔名排序會讓無後綴的 hole-finder.md 排到 hole-finder-cost.md 之後，看起來像被降級。
  withClosing.sort();
  withoutClosing.sort();

  const noClosingSuffix =
    withoutClosing.length > 0
      ? m(lang, "doctorLensNoClosingSuffix", withoutClosing.length, withoutClosing.join(joiner))
      : "";
  const closingNames = withClosing.length > 0 ? withClosing.join(joiner) : m(lang, "noneLabel");
  return m(lang, "doctorLensFoundValue", lensDir, mdFiles.length, withClosing.length, closingNames, noClosingSuffix);
}

export function buildDoctorReport(
  lang: Lang,
  cmd: string,
  providers: DoctorProvidersResult,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
  probe: DoctorProbe = DEFAULT_PROBE,
  cwd: string = process.cwd(),
): string {
  const dispatchHome = resolveDispatchHome(env, homedir);

  const apiKeyList = SECRET_ENV_VARS.map((k) => `${k.replace(/_API_KEY$/, "")} ${env[k] ? "✓" : "✗"}`).join("  ");

  const lines = [
    m(lang, "doctorHeader", cmd),
    m(lang, "doctorConfigDirLine", buildConfigDirValue(lang, env, dispatchHome)),
    m(lang, "doctorEnvLine", buildEnvValue(lang, probe, dispatchHome)),
    m(lang, "doctorApiKeyLine", apiKeyList),
    m(lang, "doctorModelListLine", buildModelListValue(lang, providers)),
    m(lang, "doctorLensLine", buildLensValue(lang, probe, cwd)),
    "",
    m(lang, "doctorFooter"),
  ];
  return lines.join("\n");
}
