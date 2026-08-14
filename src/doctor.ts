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
import { m } from "./messages.js";
import type { Lang, ProvidersFile } from "./types.js";

export interface DoctorProbe {
  fileExists: (p: string) => boolean;
  // 目錄不存在回傳 null；存在則回傳其下的檔名清單（不遞迴）。
  readDir: (p: string) => string[] | null;
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
};

export type DoctorProvidersResult = { ok: true; providers: ProvidersFile } | { ok: false; reason: string };

// 項四〈lens 定義〉：`.claude/agents/` 底下所有 hole-finder 開頭的檔，**含無後綴的
// `hole-finder.md`**——語言包確實出貨那一支，而 CLI 不限定 agent 名（validate.ts 只看
// `.claude/agents/<agent>.md` 在不在），所以它是可派的。漏算它會讓 doctor 報的支數
// 與使用者 `ls` 看到的對不上，而這支指令的用途正是「回報你手上實際有什麼」。
// `explore-haiku.md` 不算：它不是 hole-finder lens，沒有固定收尾句。
const HOLE_FINDER_LENS_PATTERN = /^hole-finder(-.+)?\.md$/;

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

function buildLensValue(lang: Lang, probe: DoctorProbe, cwd: string): string {
  const lensDir = path.join(cwd, ".claude", "agents");
  const entries = probe.readDir(lensDir);
  if (entries === null) return m(lang, "doctorLensDirMissingValue", lensDir);
  const joiner = lang === "zh" ? "、" : ", ";
  const lenses = entries
    .filter((f) => HOLE_FINDER_LENS_PATTERN.test(f))
    .map((f) => f.slice(0, -".md".length))
    .sort();
  return m(lang, "doctorLensFoundValue", lensDir, lenses.length, lenses.join(joiner));
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
