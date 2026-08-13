// plan_dispatch_v1.4.md §5：providers.json 載入與驗證。fail closed——api 欄缺失或
// store:true 即中止（exit 2），不套用預設值繼續跑（§10 步驟 3）。

import { readFile } from "node:fs/promises";
import {
  DispatchError,
  type Lang,
  type ModelPricing,
  type ProviderConfig,
  type ProvidersFile,
  type ReasoningConfig,
} from "./types.js";
import { m } from "./messages.js";

function parseReasoning(raw: unknown, providerName: string, lang: Lang): ReasoningConfig {
  if (!raw || typeof raw !== "object") {
    return { style: null, allowed: [] };
  }
  const r = raw as Record<string, unknown>;
  const style = r.style;
  if (style !== undefined && style !== "openai" && style !== "deepseek" && style !== "gemini" && style !== "anthropic") {
    throw new DispatchError(m(lang, "reasoningStyleInvalid", providerName, String(style)), 2);
  }
  const allowed = Array.isArray(r.allowed) ? r.allowed.filter((v): v is string => typeof v === "string") : [];
  const modelOverrides =
    r.modelOverrides && typeof r.modelOverrides === "object"
      ? (r.modelOverrides as Record<string, string[]>)
      : undefined;

  // §5：default 是「工單 effort 留白時實際送出的值」——不得回退到「不送參數」。
  // allowed 非空時必填，且須在 allowed 內；allowed 為空時 default 不存在（該 provider
  // 尚未驗證、不可用，連 default 都無從指定）。
  let def: string | undefined;
  if (r.default !== undefined) {
    if (typeof r.default !== "string") {
      throw new DispatchError(m(lang, "reasoningDefaultNotString", providerName), 2);
    }
    def = r.default;
  }
  if (allowed.length > 0 && def === undefined) {
    throw new DispatchError(m(lang, "reasoningDefaultMissing", providerName), 2);
  }
  if (def !== undefined && !allowed.includes(def)) {
    const list = allowed.length > 0 ? allowed.join(", ") : m(lang, "emptyList");
    throw new DispatchError(m(lang, "reasoningDefaultNotAllowed", providerName, def, list), 2);
  }

  return { style: (style as ReasoningConfig["style"]) ?? null, allowed, default: def, modelOverrides };
}

// plan_fixes_v1.0.md §4：pricing 為選填——缺席的 provider／模型無法估算成本（cost.ts
// 回傳 null，不是 0），不強制每個 provider 都要有價目。有填就驗完整，格式錯即中止
// （fail closed，與本檔其餘欄位一致），不悄悄忽略壞掉的價目導致成本估算安靜地錯。
function parsePositiveNumber(v: unknown, label: string, lang: Lang): number {
  if (typeof v !== "number" || !(v > 0)) {
    throw new DispatchError(m(lang, "positiveNumberRequired", label, JSON.stringify(v)), 2);
  }
  return v;
}

function parsePricing(raw: unknown, providerName: string, lang: Lang): Record<string, ModelPricing> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object") {
    throw new DispatchError(m(lang, "pricingNotObject", providerName), 2);
  }
  const out: Record<string, ModelPricing> = {};
  for (const [model, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") {
      throw new DispatchError(m(lang, "pricingModelNotObject", providerName, model), 2);
    }
    const e = entry as Record<string, unknown>;
    out[model] = {
      inputPerM: parsePositiveNumber(e.inputPerM, `${providerName}.pricing.${model}.inputPerM`, lang),
      outputPerM: parsePositiveNumber(e.outputPerM, `${providerName}.pricing.${model}.outputPerM`, lang),
      ...(e.cachedInputPerM !== undefined
        ? { cachedInputPerM: parsePositiveNumber(e.cachedInputPerM, `${providerName}.pricing.${model}.cachedInputPerM`, lang) }
        : {}),
      ...(e.cacheWritePerM !== undefined
        ? { cacheWritePerM: parsePositiveNumber(e.cacheWritePerM, `${providerName}.pricing.${model}.cacheWritePerM`, lang) }
        : {}),
    };
  }
  return out;
}

// v0.2.0：只取 `pricingSource.asOf`，而且**刻意寬鬆**——與上面的 `parsePricing` 相反。
// 理由是兩者性質不同：`pricing` 是計費輸入，錯了成本會安靜地算錯，所以 fail closed；
// `asOf` 只是報表上的一個查證日期，壞掉的後果是「少印一個日期」。對它 fail closed 會讓
// 一份價目完全正確的 `--providers` 檔，因為 metadata 打錯字而整個跑不起來。
function parsePricingAsOf(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const asOf = (raw as Record<string, unknown>).asOf;
  return typeof asOf === "string" && asOf.trim().length > 0 ? asOf.trim() : undefined;
}

function parseProviderConfig(name: string, raw: unknown, lang: Lang): ProviderConfig {
  if (!raw || typeof raw !== "object") {
    throw new DispatchError(m(lang, "providerConfigNotObject", name), 2);
  }
  const r = raw as Record<string, unknown>;

  // §5：api 欄無預設值，介面選擇不容猜測——缺失即中止。
  if (r.api !== "responses" && r.api !== "gemini-native" && r.api !== "anthropic-messages") {
    throw new DispatchError(m(lang, "providerApiInvalid", name, JSON.stringify(r.api)), 2);
  }

  // §5：store 不可為 true——違反設計原則 6（零留存）即中止。
  if (r.store === true) {
    throw new DispatchError(m(lang, "providerStoreTrue", name), 2);
  }
  const store: false | null = r.store === null ? null : false; // 未填視為 false

  if (typeof r.baseURL !== "string" || r.baseURL.length === 0) {
    throw new DispatchError(m(lang, "providerBaseUrlMissing", name), 2);
  }

  // §5：models 白名單。未填（或非陣列）視為空陣列 = 不做型號檢查。
  const models = Array.isArray(r.models) ? r.models.filter((v): v is string => typeof v === "string") : [];

  // §5：charsPerToken。未填時用 CLI 全域值——保留 null，不在此處套 1.0（CLI 端才知道
  // 使用者傳入的 --chars-per-token 是多少）。
  if (r.charsPerToken !== undefined && (typeof r.charsPerToken !== "number" || !(r.charsPerToken > 0))) {
    throw new DispatchError(m(lang, "providerCharsPerTokenInvalid", name), 2);
  }
  const charsPerToken = typeof r.charsPerToken === "number" ? r.charsPerToken : null;

  return {
    baseURL: r.baseURL,
    api: r.api,
    store,
    toolCalling: r.toolCalling === true,
    reasoning: parseReasoning(r.reasoning, name, lang),
    models,
    charsPerToken,
    tpmLimit: typeof r.tpmLimit === "number" ? r.tpmLimit : null,
    maxSpokeTokens: typeof r.maxSpokeTokens === "number" ? r.maxSpokeTokens : null,
    pricing: parsePricing(r.pricing, name, lang),
    pricingAsOf: parsePricingAsOf(r.pricingSource),
  };
}

// plan_dispatch_v1.10.md §24.3：providers.json 隨工具出貨，不可覆寫（方案 D）。
// formatVersion 沿用 `_dispatch.md` 首行 `<!-- format: v1 -->` 的既有做法——版本檢查
// 在載入時做，不符即中止，防跨版本漂移（一份舊版 providers.json 寫著已證實不生效的
// 參數路徑，可能回顯、不報錯，行為完全不受控，facts_dispatch.md 2026-08-06 已有實例）。
export const PROVIDERS_FORMAT_VERSION = 1;

export function parseProvidersFile(json: unknown, lang: Lang): ProvidersFile {
  if (!json || typeof json !== "object") {
    throw new DispatchError(m(lang, "providersFileNotObject"), 2);
  }
  const { formatVersion, ...providerEntries } = json as Record<string, unknown>;
  if (formatVersion !== PROVIDERS_FORMAT_VERSION) {
    throw new DispatchError(
      m(lang, "providersFormatVersionMismatch", PROVIDERS_FORMAT_VERSION, JSON.stringify(formatVersion)),
      2,
    );
  }
  const out: ProvidersFile = {};
  for (const [name, raw] of Object.entries(providerEntries)) {
    out[name] = parseProviderConfig(name, raw, lang);
  }
  return out;
}

export async function loadProviders(filePath: string, lang: Lang): Promise<ProvidersFile> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    throw new DispatchError(m(lang, "missingProviders", filePath), 2);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new DispatchError(m(lang, "providersFileInvalidJson", (err as Error).message), 2);
  }
  return parseProvidersFile(json, lang);
}

export function getProviderConfig(providers: ProvidersFile, name: string, lang: Lang): ProviderConfig {
  const config = providers[name];
  if (!config) {
    throw new DispatchError(m(lang, "providerUndefined", name), 2);
  }
  return config;
}
