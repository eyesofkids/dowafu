import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { now } from "./db.js";
import { DispatchError, type Lang, type ModelPricing, type ProviderConfig, type ProvidersFile } from "./types.js";
import { m } from "./messages.js";
import { parseProvidersFile } from "./providers.js";
import { bundledProvidersPath } from "./pkg-info.js";

// 2026-10-16（v0_9_0 #41）：gpt-5.6-luna → gpt-6-luna、claude-haiku-4-5-20251001 → claude-haiku-5-5。
// 新的兩個更便宜且 verify:providers 實跑通過；haiku-4-5 不收 effort／adaptive thinking，在 dowafu 從來派不出去。
const DEFAULT_ENABLED = new Set([
  "gpt-6-luna",
  // 2026-09-12：預設改為 deepseek-flash。deepseek-v4-flash 已於 2026-09-10 退役，
  // 目前只是暫時轉址到 V4.1 Flash 且官方未給截止日——預設開一個隨時會消失的型號，
  // 壞法會是「新裝的人某天突然跑不動」。deepseek-flash 已 smoke 實跑通過。
  "deepseek-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "claude-haiku-5-5",
]);

export type StoredModel = {
  provider: string;
  model: string;
  inputPerM: number | undefined;
  cachedInputPerM: number | undefined;
  cacheWritePerM: number | undefined;
  outputPerM: number | undefined;
  enabled: boolean;
};

type SourceFile = { providers: ProvidersFile; pricingSources: Record<string, unknown> };

// 解析與讀檔分開：播種必須是同步的（protocol.ts／stdio.ts 都是同步，
// 讓它們變 async 會一路波及到還沒寫的 HTTP binding），而 import 走 async 讀檔。
// 兩條路共用同一份解析，避免「兩種入口兩種嚴格度」。
function parseSourceText(text: string, lang: Lang): SourceFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new DispatchError(m(lang, "providersFileInvalidJson", (err as Error).message), 2);
  }
  const providers = parseProvidersFile(raw, lang);
  const entries = raw as Record<string, unknown>;
  const pricingSources: Record<string, unknown> = {};
  for (const name of Object.keys(providers)) {
    const source = entries[name] as Record<string, unknown>;
    pricingSources[name] = source.pricingSource ?? null;
  }
  return { providers, pricingSources };
}

export async function readProvidersFile(filePath: string, lang: Lang): Promise<SourceFile> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    throw new DispatchError(m(lang, "missingProviders", filePath), 2);
  }
  return parseSourceText(text, lang);
}

// 熱修補（票 A 驗收缺口二）：空表要自動播種出貨檔。
//
// 驗收發現全新安裝完全跑不動——models 表是空的，addSpoke 回「白名單為空」，
// 而使用者得自己找出 bundled providers.json 的路徑（在全域安裝裡帶版本號與相依雜湊，
// report.ts 的註解就寫著「猜不到」）。更糟的是 bundled 旗標用路徑完全相等判定，
// 所以複製一份自己的副本再 import 會得到「12 個型號全關」，而且沒有任何提示。
//
// hub 原本的裁示是「只由 providers import 明確觸發，不做啟動時自動偵測」——那句話
// 講的是**合流**（升級後蓋掉價目，會在使用者不知情時改掉計費基準），不是**首次播種**
// （空表放進出貨資料，沒有覆蓋任何東西）。措辭沒分開，故此處修正：只在**完全空表**時播種。
//
// 回傳是否真的播了種——呼叫端要據此印出通知。**播種不得靜默**。
export function seedIfEmpty(db: DatabaseSync, lang: Lang): boolean {
  const count = (db.prepare("SELECT count(*) AS c FROM models").get() as { c: number }).c;
  if (Number(count) > 0) return false;
  const filePath = bundledProvidersPath();
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    throw new DispatchError(m(lang, "missingProviders", filePath), 2);
  }
  // bundled = true：出貨檔才套用 DEFAULT_ENABLED 那五個。
  mergeProviders(db, parseSourceText(text, lang), true);
  return true;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

export function mergeProviders(db: DatabaseSync, source: SourceFile, bundled: boolean): void {
  const timestamp = now();
  db.exec("BEGIN");
  try {
    for (const [name, config] of Object.entries(source.providers)) {
      db.prepare(`INSERT INTO providers (name, base_url, api, store, tool_calling, reasoning, chars_per_token, tpm_limit, max_spoke_tokens, pricing_source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET base_url=excluded.base_url, api=excluded.api, store=excluded.store,
          tool_calling=excluded.tool_calling, reasoning=excluded.reasoning, chars_per_token=excluded.chars_per_token,
          tpm_limit=excluded.tpm_limit, max_spoke_tokens=excluded.max_spoke_tokens, pricing_source=excluded.pricing_source,
          updated_at=excluded.updated_at`)
        .run(name, config.baseURL, config.api, config.store === null ? null : 0, config.toolCalling ? 1 : 0,
          json(config.reasoning), config.charsPerToken, config.tpmLimit, config.maxSpokeTokens, json(source.pricingSources[name]), timestamp);
      for (const model of config.models) {
        const price = config.pricing?.[model];
        const old = db.prepare("SELECT enabled FROM models WHERE provider = ? AND model = ?").get(name, model) as { enabled: number } | undefined;
        const enabled = old ? old.enabled : bundled && DEFAULT_ENABLED.has(model) ? 1 : 0;
        db.prepare(`INSERT INTO models (provider, model, input_per_m, cached_input_per_m, cache_write_per_m, output_per_m, enabled, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider, model) DO UPDATE SET input_per_m=excluded.input_per_m, cached_input_per_m=excluded.cached_input_per_m,
            cache_write_per_m=excluded.cache_write_per_m, output_per_m=excluded.output_per_m, enabled=models.enabled, updated_at=excluded.updated_at`)
          .run(name, model, price?.inputPerM ?? null, price?.cachedInputPerM ?? null, price?.cacheWritePerM ?? null, price?.outputPerM ?? null, enabled, timestamp);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function loadProviders(db: DatabaseSync, lang: Lang): ProvidersFile {
  const providers: ProvidersFile = {};
  const rows = db.prepare("SELECT name, base_url, api, store, tool_calling, reasoning, chars_per_token, tpm_limit, max_spoke_tokens, pricing_source FROM providers ORDER BY name").all() as Array<Record<string, unknown>>;
  const models = listModels(db);
  for (const row of rows) {
    const name = String(row.name);
    let reasoning: ProviderConfig["reasoning"];
    let source: unknown;
    try {
      reasoning = JSON.parse(String(row.reasoning)) as ProviderConfig["reasoning"];
      source = row.pricing_source === null ? null : JSON.parse(String(row.pricing_source));
    } catch {
      throw new DispatchError(m(lang, "providersDbCorrupt", name), 2);
    }
    const own = models.filter((model) => model.provider === name);
    if (own.length === 0) throw new DispatchError(m(lang, "providersDbCorrupt", name), 2);
    const pricing: Record<string, ModelPricing> = {};
    for (const model of own) {
      if (model.inputPerM !== undefined && model.outputPerM !== undefined) {
        pricing[model.model] = {
          inputPerM: model.inputPerM,
          outputPerM: model.outputPerM,
          ...(model.cachedInputPerM !== undefined ? { cachedInputPerM: model.cachedInputPerM } : {}),
          ...(model.cacheWritePerM !== undefined ? { cacheWritePerM: model.cacheWritePerM } : {}),
        };
      }
    }
    const asOf = source && typeof source === "object" && typeof (source as Record<string, unknown>).asOf === "string"
      ? (source as Record<string, unknown>).asOf as string : undefined;
    providers[name] = {
      baseURL: String(row.base_url), api: row.api as ProviderConfig["api"], store: row.store === null ? null : false,
      toolCalling: Number(row.tool_calling) === 1, reasoning, models: own.map((model) => model.model),
      charsPerToken: row.chars_per_token === null ? null : Number(row.chars_per_token),
      tpmLimit: row.tpm_limit === null ? null : Number(row.tpm_limit),
      maxSpokeTokens: row.max_spoke_tokens === null ? null : Number(row.max_spoke_tokens),
      ...(Object.keys(pricing).length > 0 ? { pricing } : {}), ...(asOf ? { pricingAsOf: asOf } : {}),
    };
  }
  return providers;
}

export function listModels(db: DatabaseSync): StoredModel[] {
  return (db.prepare("SELECT provider, model, input_per_m, cached_input_per_m, cache_write_per_m, output_per_m, enabled FROM models ORDER BY provider, model").all() as Array<Record<string, unknown>>)
    .map((row) => ({ provider: String(row.provider), model: String(row.model), inputPerM: row.input_per_m === null ? undefined : Number(row.input_per_m), cachedInputPerM: row.cached_input_per_m === null ? undefined : Number(row.cached_input_per_m), cacheWritePerM: row.cache_write_per_m === null ? undefined : Number(row.cache_write_per_m), outputPerM: row.output_per_m === null ? undefined : Number(row.output_per_m), enabled: Number(row.enabled) === 1 }));
}

export function isModelEnabled(db: DatabaseSync, provider: string, model: string): boolean {
  return (db.prepare("SELECT enabled FROM models WHERE provider = ? AND model = ?").get(provider, model) as { enabled?: number } | undefined)?.enabled === 1;
}

export function setModelEnabled(db: DatabaseSync, providerOrModel: string, maybeModel: string | undefined, enabled: boolean, lang: Lang): void {
  const matches = maybeModel === undefined
    ? db.prepare("SELECT provider, model FROM models WHERE model = ? ORDER BY provider").all(providerOrModel) as Array<{ provider: string; model: string }>
    : db.prepare("SELECT provider, model FROM models WHERE provider = ? AND model = ?").all(providerOrModel, maybeModel) as Array<{ provider: string; model: string }>;
  const model = maybeModel ?? providerOrModel;
  if (matches.length === 0) throw new DispatchError(m(lang, "providerModelNotFound", model), 2);
  if (matches.length > 1) throw new DispatchError(m(lang, "providerModelAmbiguous", model, matches.map((item) => item.provider).join(", ")), 2);
  db.prepare("UPDATE models SET enabled = ?, updated_at = ? WHERE provider = ? AND model = ?").run(enabled ? 1 : 0, now(), matches[0].provider, matches[0].model);
}
