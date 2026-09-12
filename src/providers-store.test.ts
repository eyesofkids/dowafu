import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDb } from "./db.js";
import { bundledProvidersPath } from "./pkg-info.js";
import { DispatchError } from "./types.js";
import { listModels, loadProviders, mergeProviders, readProvidersFile, seedIfEmpty, setModelEnabled } from "./providers-store.js";
import { addSpoke, createTicket } from "./ticket-store.js";
import { m } from "./messages.js";
import { getCommandName } from "./pkg-info.js";

function withDb(run: (dbPath: string, root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), "providers-store-"));
  return run(path.join(root, "dowafu.db"), root).finally(() => rmSync(root, { recursive: true, force: true }));
}

function provider(models: string[], pricing: Record<string, unknown> = {}) {
  return { baseURL: "https://example.test", api: "responses", store: false, toolCalling: true, reasoning: { style: "openai", allowed: ["low"], default: "low" }, models, tpmLimit: null, maxSpokeTokens: null, pricing, pricingSource: { asOf: "2026-09-02", url: "https://never-fetch.example" } };
}

function normalize(value: unknown): unknown {
  const parsed = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  for (const config of Object.values(parsed)) {
    if (config && typeof config === "object" && Array.isArray((config as Record<string, unknown>).models)) {
      ((config as Record<string, unknown>).models as string[]).sort();
    }
  }
  return parsed;
}

test("providers store：bundled 匯入無損，五開十關", async () => {
  await withDb(async (dbPath) => {
    const db = openDb(dbPath);
    const source = await readProvidersFile(bundledProvidersPath(), "en");
    mergeProviders(db, source, true);
    assert.deepEqual(normalize(loadProviders(db, "en")), normalize(source.providers));
    const enabled = listModels(db).filter((model) => model.enabled).map((model) => model.model).sort();
    assert.deepEqual(enabled, ["claude-haiku-4-5-20251001", "deepseek-flash", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gpt-5.6-luna"]);
  });
});

test("providers store：外部 import 新增同名預設型號仍關閉，合流保留舊 enabled 與下架列", async () => {
  await withDb(async (dbPath, root) => {
    const db = openDb(dbPath);
    const bundled = await readProvidersFile(bundledProvidersPath(), "en");
    mergeProviders(db, bundled, true);
    const external = path.join(root, "gateway.json");
    writeFileSync(external, JSON.stringify({ formatVersion: 1, gateway: provider(["deepseek-v4-flash", "old"], { "deepseek-v4-flash": { inputPerM: 1, outputPerM: 2 } }) }));
    mergeProviders(db, await readProvidersFile(external, "en"), false);
    assert.equal(listModels(db).find((row) => row.provider === "gateway" && row.model === "deepseek-v4-flash")?.enabled, false);
    setModelEnabled(db, "gateway", "deepseek-v4-flash", true, "en");
    writeFileSync(external, JSON.stringify({ formatVersion: 1, gateway: provider(["deepseek-v4-flash"]) }));
    mergeProviders(db, await readProvidersFile(external, "en"), false);
    assert.equal(listModels(db).find((row) => row.provider === "gateway" && row.model === "deepseek-v4-flash")?.enabled, true);
    assert.ok(listModels(db).some((row) => row.provider === "gateway" && row.model === "old"));
  });
});

test("providers store：撞名的短形式拒絕且不動任何列，指定形式只改指定列", async () => {
  await withDb(async (dbPath, root) => {
    const db = openDb(dbPath);
    const file = path.join(root, "two.json");
    writeFileSync(file, JSON.stringify({ formatVersion: 1, direct: provider(["same"]), gateway: provider(["same"]) }));
    mergeProviders(db, await readProvidersFile(file, "en"), false);
    assert.throws(() => setModelEnabled(db, "same", undefined, true, "en"), DispatchError);
    assert.deepEqual(listModels(db).filter((row) => row.model === "same").map((row) => row.enabled), [false, false]);
    setModelEnabled(db, "gateway", "same", true, "en");
    assert.deepEqual(listModels(db).filter((row) => row.model === "same").map((row) => [row.provider, row.enabled]), [["direct", false], ["gateway", true]]);
  });
});

test("providers store：壞 models 或 pricing key 在寫入前拒絕，DB 不會部分更新", async () => {
  await withDb(async (dbPath, root) => {
    const db = openDb(dbPath);
    const file = path.join(root, "bad.json");
    writeFileSync(file, JSON.stringify({ formatVersion: 1, good: provider(["a"]), bad: provider([]) }));
    await assert.rejects(readProvidersFile(file, "en"), DispatchError);
    assert.equal(listModels(db).length, 0);
    writeFileSync(file, JSON.stringify({ formatVersion: 1, bad: provider(["a"], { b: { inputPerM: 1, outputPerM: 2 } }) }));
    await assert.rejects(readProvidersFile(file, "en"), DispatchError);
    assert.equal(listModels(db).length, 0);
  });
});

// --- 熱修補（票 A 驗收缺口二、三） ---

test("熱修補：空表 seedIfEmpty 播種出貨檔，且只開 DEFAULT_ENABLED 那五個", async () => {
  await withDb(async (dbPath) => {
    const db = openDb(dbPath, "en");
    assert.equal(listModels(db).length, 0);
    assert.equal(seedIfEmpty(db, "en"), true, "空表應回報有播種");
    const models = listModels(db);
    assert.equal(models.length, 15);
    const on = models.filter((model) => model.enabled).map((model) => model.model).sort();
    assert.deepEqual(on, [
      "claude-haiku-4-5-20251001",
      "deepseek-flash",
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash-lite",
      "gpt-5.6-luna",
    ]);
    // 出貨檔的 bundled 旗標必須生效——這是「複製一份自己 import 會 12 個全關」那個
    // 缺口的反面，seedIfEmpty 一律當作 bundled。
    assert.equal(models.filter((model) => model.enabled).length, 5);
  });
});

test("熱修補：seedIfEmpty 不覆蓋既有內容，也不重播", async () => {
  await withDb(async (dbPath) => {
    const db = openDb(dbPath, "en");
    seedIfEmpty(db, "en");
    setModelEnabled(db, "anthropic", "claude-opus-5", true, "en");
    assert.equal(seedIfEmpty(db, "en"), false, "非空表不應再播種");
    const opus = listModels(db).find((model) => model.model === "claude-opus-5");
    assert.equal(opus?.enabled, true, "使用者手動開的型號不得被再播種沖掉");
  });
});

test("熱修補：providers 表為空時，addSpoke 講的是「去匯入」而不是「白名單為空」", async () => {
  await withDb(async (dbPath) => {
    const db = openDb(dbPath, "en");
    createTicket(db, "sample", "# 待審段落\n內容\n", "en");
    assert.throws(
      () => addSpoke(db, "sample", { agent: "hole-finder-cost", provider: "deepseek", model: "deepseek-v4-flash", body: "# 具體問題\n1. 問題\n\n# 允許讀取\n" }, "en"),
      (err: unknown) => err instanceof DispatchError && err.message === m("en", "providersDbEmpty", getCommandName()),
    );
  });
});
