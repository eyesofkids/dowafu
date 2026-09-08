#!/usr/bin/env node
// plan_dispatch_v1.4.md §9/§10：CLI 入口，串起 §10 執行流程 1–10。
// plan_dispatch_v1.10.md §10：新增步驟 0（設定解析）與步驟 6.5（gitignore 三態檢查），
// 皆在任何 API 呼叫之前。引數解析、說明文字、事件格式化拆到 cli-args.ts（純函式，
// 供單元測試）；此檔只負責串接與 I/O。

import path from "node:path";
import { readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { DispatchError, type Adapter, type ProviderConfig } from "./types.js";
import { loadProviders } from "./providers.js";
import { loadTicket } from "./ticket.js";
import { resolveSpokes, type ResolvedSpoke } from "./validate.js";
import { estimateTokens, estimateAllowlistTokens, estimateSequentialRead, checkGateOne, type SpokeEstimate, type AllowlistEstimate } from "./gate.js";
import { buildFirstUserText, buildSystemPrompt } from "./prompt.js";
import { buildReport, effectiveCap, effectiveCharsPerToken, type ProvidersSource } from "./report.js";
import { checkGitignore } from "./gitignore-check.js";
import { runSpoke, type RunEvent } from "./runner.js";
import { Semaphore } from "./semaphore.js";
import { createResponsesAdapter } from "./adapters/responses.js";
import { createGeminiAdapter } from "./adapters/gemini-native.js";
import { createAnthropicAdapter } from "./adapters/anthropic-messages.js";
import { auditSpoke } from "./audit.js";
import { auditToolCalls, type ToolCallAudit } from "./tool-call-audit.js";
import { persistSpokeResultDb, readResults, writeSummaryDb } from "./output.js";
import { recordRound } from "./progress.js";
import { registerSecrets, maskString, maskDeep } from "./mask.js";
import { buildDoctorReportData, renderDoctorReport, type DoctorProvidersResult } from "./doctor.js";
import { bundledProvidersPath, getPackageVersion, getCommandName } from "./pkg-info.js";
import { buildJsonPayload, buildJsonPlan } from "./json-output.js";
import { parseArgs, formatEvent, resolveLang, resolveFallbackLang, buildStdoutSummary } from "./cli-args.js";
import { m } from "./messages.js";
import type { SpokeRunResult } from "./types.js";
import { defaultDbPath, openDb } from "./db.js";
import { issueToken, listTokens, revokeToken } from "./api-token.js";
import { addAllow, addSpoke, createTicket, formatTicket, hasResults, importTicketDirectory } from "./ticket-store.js";
import { approveJob, findJobsByIdPrefix, getJob, listPendingApprovalJobs } from "./job.js";
import { serve, stopDaemon } from "./daemon.js";
import { daemonAlive, daemonStatePath } from "./liveness.js";
import { startStdioServer } from "./mcp/stdio.js";
import { isModelEnabled, listModels, mergeProviders, readProvidersFile, seedIfEmpty, setModelEnabled } from "./providers-store.js";
import {
  buildKeyStatusRows,
  getProviderKey,
  listKnownProviderNames,
  listProviderKeys,
  maskTail,
  removeProviderKey,
  recordProviderKeyTest,
  setProviderKey,
  type KeyStatusRow,
} from "./provider-key.js";

// §29 規格十：窮盡式分派，不留「其餘落到 gemini」的 fallback——那會讓未來第四家 provider
// 靜默走錯 adapter。switch 缺 case 時 TypeScript 因「不是每條路徑都回傳值」編譯失敗。
function buildAdapterForConfig(providerConfig: ProviderConfig, apiKey: string, lang: "en" | "zh"): Adapter {
  switch (providerConfig.api) {
    case "responses":
      return createResponsesAdapter({
        baseURL: providerConfig.baseURL,
        apiKey,
        store: providerConfig.store,
        reasoning: providerConfig.reasoning,
        lang,
      });
    case "gemini-native":
      return createGeminiAdapter({ apiKey, baseURL: providerConfig.baseURL, lang });
    case "anthropic-messages":
      return createAnthropicAdapter({
        baseURL: providerConfig.baseURL,
        apiKey,
        reasoning: providerConfig.reasoning,
        lang,
      });
  }
}

// 工單 key-db §B：API key 的唯一來源是 DB 的 `provider_keys` 表（0.5.0 起不讀環境變數，
// 使用者裁示 2026-09-06，理由見 provider-key.ts 檔頭）。resolveSpokes 更早的那道齊備檢查
// 現在收 hasApiKey 回呼、問的是同一張表，兩處不會分岔。
function createAdapterFor(spoke: ResolvedSpoke, db: DatabaseSync): Adapter {
  const apiKey = getProviderKey(db, spoke.provider)?.apiKey;
  if (!apiKey) {
    // resolveSpokes 已檢查過，此處為型別窄化防禦。用 spoke.lang 而非 langRaw／options.lang——
    // 它是 ResolvedSpoke 上已經過 resolveLang 判定的權威值，與 run-level lang 同一個來源。
    throw new DispatchError(m(spoke.lang, "apiKeyMissing", spoke.provider), 2);
  }
  return buildAdapterForConfig(spoke.providerConfig, apiKey, spoke.lang);
}

// v1.10 §25：--json 下，人類可讀輸出（報表／即時事件／摘要）全部改走 stderr，stdout
// 只留給最後那個單一 JSON 物件。錯誤訊息本來就走 stderr（既有行為），不受此影響。
type Logger = { info: (msg: string) => void };
function makeLogger(json: boolean): Logger {
  return { info: (msg: string) => (json ? console.error(msg) : console.log(msg)) };
}

// 熱修補（票 B 驗收）：候選清單要印幾碼才夠分辨。最少 8 碼（維持原本的簡短），
// 但若在候選之間仍有重複就一路加長到能區分為止；全等時退回完整 id。
function shortestDistinctIdWidth(ids: string[]): number {
  const longest = Math.max(0, ...ids.map((id) => id.length));
  for (let width = 8; width < longest; width++) {
    if (new Set(ids.map((id) => id.slice(0, width))).size === ids.length) return width;
  }
  return longest;
}

// 熱修補（票 A 驗收缺口二）：所有經 CLI 開啟的 DB 都在空表時播種一次出貨檔。
// 通知走 **stderr**——stdout 要留給 --json 與 MCP 的 JSON-RPC，多印一行會壞掉契約。
//
// 工單 key-db §D：這是唯一開 DB 的地方，所以也是唯一需要重新註冊遮罩名單的地方——
// DB 裡存著的每一把 provider key，不管這次會不會被用到，全部餵進 registerSecrets。
// registerSecrets 是覆寫不是累加（mask.ts 的陷阱，見票 §D 引用的 v0_5_0/_archived/log.md §十四），
// 這裡若只餵 DB 那份會蓋掉 main() 頂部已經註冊過的 env 來源，因此兩份要一起餵。
function openDbSeeded(dbPath: string | undefined, lang: "en" | "zh"): ReturnType<typeof openDb> {
  const db = openDb(dbPath, lang);
  if (seedIfEmpty(db, lang)) console.error(m(lang, "providersSeeded", bundledProvidersPath()));
  registerSecrets(listProviderKeys(db).map((key) => key.apiKey));
  return db;
}

// 工單 status-stdin §B：使用者裁示（2026-09-07）——D1 把工單本體移進 DB 之後，
// `ticket-store.ts` 的 createTicket／addSpoke 本來就吃字串，問題只在這裡（CLI）先把
// 內容寫成暫存檔、CLI 再讀那個檔，等於繞了一圈。`-` 代表從 stdin 讀本文，與路徑寫法
// 共用同一個位置（`<shared-file>`／`<body-file>`），add-spoke 選用的 `[effort]` 因此
// 不受影響，仍然在同一個位置解析。
//
// 匯出是為了讓「stdin 是 TTY」這個守衛能被直接單元測試：真的 TTY 在自動化測試裡無法
// 可靠模擬（沒有 pty），而 cli.ts 這個模組本身在被 import 的當下就會執行 main()，
// 不能拿來 import 後再呼叫——所以守衛本身必須是一個不依賴模組載入副作用、可以單獨
// 呼叫驗證的純函式。
export function assertStdinPiped(isTTY: boolean | undefined, lang: "en" | "zh"): void {
  if (isTTY) throw new DispatchError(m(lang, "ticketStdinRequiresPipe"), 2);
}

async function readBodyOrStdin(pathOrDash: string, lang: "en" | "zh"): Promise<string> {
  if (pathOrDash !== "-") return readFile(pathOrDash, "utf8");
  // 先檢查再讀：TTY 情況下 for-await 會掛住等鍵盤輸入，必須在那之前就中止（不卡住）。
  assertStdinPiped(process.stdin.isTTY, lang);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function ticketCommand(argv: string[], lang: "en" | "zh"): Promise<void> {
  const command = getCommandName();
  const args = [...argv];
  let dbPath: string | undefined;
  let repoRoot = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db") {
      dbPath = args[i + 1];
      args.splice(i, 2);
      i--;
    } else if (args[i] === "--repo-root") {
      repoRoot = path.resolve(args[i + 1] ?? "");
      args.splice(i, 2);
      i--;
    }
  }
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") {
    console.log(m(lang, "ticketHelp", command));
    return;
  }
  const db = openDbSeeded(dbPath, lang);
  switch (action) {
    case "create": {
      const [name, sharedPath] = rest;
      if (!name || !sharedPath) throw new DispatchError(m(lang, "ticketHelp", command), 2);
      createTicket(db, name, await readBodyOrStdin(sharedPath, lang), lang);
      return;
    }
    case "add-spoke": {
      const [name, agent, provider, model, bodyPath, effort] = rest;
      if (!name || !agent || !provider || !model || !bodyPath) throw new DispatchError(m(lang, "ticketHelp", command), 2);
      addSpoke(db, name, { agent, provider, model, body: await readBodyOrStdin(bodyPath, lang), effort }, lang);
      return;
    }
    case "add-allow": {
      const [name, agent, rel] = rest;
      if (!name || !agent || !rel) throw new DispatchError(m(lang, "ticketHelp", command), 2);
      await addAllow(db, name, agent, rel, repoRoot, lang);
      return;
    }
    case "import": {
      const [dir, suppliedName] = rest;
      if (!dir) throw new DispatchError(m(lang, "ticketHelp", command), 2);
      await importTicketDirectory(db, dir, suppliedName ?? path.basename(path.resolve(dir)), repoRoot, lang);
      return;
    }
    case "show": {
      const [name] = rest;
      if (!name) throw new DispatchError(m(lang, "ticketHelp", command), 2);
      console.log(formatTicket(db, name, lang));
      return;
    }
    default:
      throw new DispatchError(m(lang, "ticketHelp", command), 2);
  }
}

async function providersCommand(argv: string[], lang: "en" | "zh"): Promise<void> {
  const args = [...argv];
  let dbPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db") { dbPath = args[i + 1]; args.splice(i, 2); i--; }
  }
  const [action, ...rest] = args;
  const command = getCommandName();
  if (!action || action === "--help" || action === "-h") { console.log(m(lang, "providersHelp", command)); return; }
  const db = openDbSeeded(dbPath, lang);
  if (action === "list") {
    const models = listModels(db);
    if (models.length === 0) console.log(m(lang, "providersListEmpty"));
    for (const model of models) console.log(m(lang, "providersListRow", model.provider, model.model, model.inputPerM?.toString() ?? "—", model.outputPerM?.toString() ?? "—", model.enabled));
    return;
  }
  if (action === "import") {
    const [filePath] = rest;
    if (!filePath) throw new DispatchError(m(lang, "providersHelp", command), 2);
    mergeProviders(db, await readProvidersFile(path.resolve(filePath), lang), path.resolve(filePath) === bundledProvidersPath());
    console.log(m(lang, "providersImported", filePath));
    return;
  }
  if (action === "enable" || action === "disable") {
    const [first, second, third] = rest;
    if (!first || third !== undefined) throw new DispatchError(m(lang, "providersHelp", command), 2);
    setModelEnabled(db, first, second, action === "enable", lang);
    console.log(m(lang, action === "enable" ? "providersEnabled" : "providersDisabled", second ?? first));
    return;
  }
  throw new DispatchError(m(lang, "providersHelp", command), 2);
}

// 工單 C §B-2：入站 HTTP 憑證的發／驗／撤銷 CLI 面積。與 providers/ticket 子指令同一種
// 「--db 先剝離、其餘走一個小 switch」形狀。
async function tokenCommand(argv: string[], lang: "en" | "zh"): Promise<void> {
  const command = getCommandName();
  const args = [...argv];
  let dbPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db") { dbPath = args[i + 1]; args.splice(i, 2); i--; }
  }
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") { console.log(m(lang, "tokenHelp", command)); return; }
  const db = openDbSeeded(dbPath, lang);
  switch (action) {
    case "issue": {
      let label: string | undefined;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--label") label = rest[i + 1];
      }
      const { id, plaintext } = issueToken(db, label);
      console.log(m(lang, "tokenIssued", id, plaintext));
      return;
    }
    case "list": {
      const tokens = listTokens(db);
      if (tokens.length === 0) { console.log(m(lang, "tokenListEmpty")); return; }
      for (const t of tokens) console.log(m(lang, "tokenListRow", t.id, t.label ?? "—", t.created_at, t.revoked_at !== null));
      return;
    }
    case "revoke": {
      const [id] = rest;
      if (!id) throw new DispatchError(m(lang, "tokenHelp", command), 2);
      revokeToken(db, id, lang);
      console.log(m(lang, "tokenRevoked", id));
      return;
    }
    default:
      throw new DispatchError(m(lang, "tokenHelp", command), 2);
  }
}

async function confirm(message: string, output: NodeJS.WritableStream): Promise<boolean> {
  // 非互動環境（agent 經 shell 呼叫時 stdin 不是 TTY）沒有人能回答這個提示。
  // fail closed：先前這裡 return true，等於唯一的付費閘門是操作文件裡的一句話；
  // 要在這種環境派工必須明確帶 --yes。
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output });
  const answer = await rl.question(message);
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

// 工單 key-db §C-1 之1：貼上時不回顯，但這是唯一需要逐字元收字的地方——readline/promises
// 的 question() 沒有隱藏輸入的選項。用 raw mode 自行收字元，僅在 Enter 時換行，不逐字回顯；
// Backspace 可修正，Ctrl+C 直接離開（不留在 raw mode）。
async function readSecret(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise<string>((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\n" || char === "\r") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (char === "\u0003") {
          // Ctrl+C：離開前恢復終端機模式，不留在 raw mode。
          cleanup();
          process.stdout.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };
    stdin.on("data", onData);
  });
}

function assertKnownProvider(db: DatabaseSync, provider: string, lang: "en" | "zh"): void {
  const known = listKnownProviderNames(db);
  if (!known.includes(provider)) {
    throw new DispatchError(m(lang, "keyUnknownProvider", provider, known.join(", ")), 2);
  }
}

// `dowafu key`（互動選單）、`key list` 共用的狀態字串。0.5.0 起 DB 是唯一來源，
// 所以「有沒有設定」就等於 maskedTail 是不是 null——沒有來源欄位要顯示。
function keyStatusText(lang: "en" | "zh", row: KeyStatusRow): string {
  if (row.maskedTail === null) return m(lang, "keyStatusMissing");
  const configured = m(lang, "keyStatusDb", row.maskedTail, row.updatedAt ? row.updatedAt.slice(0, 10) : "");
  if (row.lastTestSucceeded === null || row.lastTestedAt === null || row.lastTestModel === null) return configured + m(lang, "keyStatusUntested");
  return configured + m(
    lang,
    row.lastTestSucceeded ? "keyStatusTestSucceeded" : "keyStatusTestFailed",
    row.lastTestModel,
    row.lastTestedAt.slice(0, 10),
  );
}

// 工單 key-db §C-2／§G 第 7 步：`key test <provider>`——會花錢，跑之前明講；也被互動流程
// 「存完問要不要立即驗」（裁示 2）重用。實作與測試階段本身不得打真實 API（票 §不要做的事 #2）
// ——這裡呼叫真實 adapter 是設計上必要的（要驗證的正是「這把 key 打得通」），成本閘門是
// 下面的 confirm()，不是不實作；本票自己的驗證改用假 adapter／假 server，見 report 的
// 「變異」一節。
export type KeyTestSender = (input: { providerConfig: ProviderConfig; apiKey: string; model: string; lang: "en" | "zh" }) => Promise<void>;

export type KeyTestOutcome = { model: string; succeeded: true } | { model: string; succeeded: false; detail: string };

// key-visibility §B-0：把付費邊界抽成可注入 sender。此函式不做 console I/O，測試可用假
// sender 同時覆核成功與失敗寫回 DB；正式呼叫仍由 runKeyTest 保留原本的確認與輸出責任。
export async function executeKeyTest(
  db: DatabaseSync,
  provider: string,
  lang: "en" | "zh",
  send: KeyTestSender,
): Promise<KeyTestOutcome> {
  const stored = getProviderKey(db, provider);
  if (!stored) throw new DispatchError(m(lang, "keyTestKeyMissing", provider), 2);
  const providers = loadProviders(db, lang);
  const providerConfig = providers[provider];
  if (!providerConfig) throw new DispatchError(m(lang, "keyUnknownProvider", provider, Object.keys(providers).join(", ")), 2);
  const candidates = listModels(db).filter((model) => model.provider === provider && model.enabled);
  if (candidates.length === 0) throw new DispatchError(m(lang, "keyTestNoEnabledModel", provider), 2);
  const model = candidates[0].model;
  try {
    await send({ providerConfig, apiKey: stored.apiKey, model, lang });
    recordProviderKeyTest(db, provider, model, true);
    return { model, succeeded: true };
  } catch (err) {
    const detail = maskString(String(err));
    recordProviderKeyTest(db, provider, model, false);
    return { model, succeeded: false, detail };
  }
}

async function runKeyTest(db: DatabaseSync, provider: string, lang: "en" | "zh"): Promise<void> {
  console.log(m(lang, "keyTestCostWarning", provider));
  const ok = await confirm(m(lang, "keyTestConfirmPrompt"), process.stdout);
  if (!ok) {
    console.log(m(lang, "keyTestCancelled"));
    return;
  }
  const outcome = await executeKeyTest(db, provider, lang, async ({ providerConfig, apiKey, model, lang: testLang }) => {
    const adapter = buildAdapterForConfig(providerConfig, apiKey, testLang);
    await adapter.send(
      { systemPrompt: "", turns: [{ role: "user", text: "ping" }] },
      { model, effort: providerConfig.reasoning.default, enableTools: false },
    );
  });
  if (outcome.succeeded) {
    console.log(m(lang, "keyTestSucceeded", provider, outcome.model));
    return;
  }
  throw new DispatchError(m(lang, "keyTestFailed", provider, outcome.detail), 2);
}

// 工單 key-db §C：`dowafu key`（免參數，互動）／`key list`／`key rm`／`key test`。
// 裁示 1／3：不吃命令列參數、不留非互動的寫入路徑——互動選單在 stdin 不是 TTY 時必須
// 明確拒絕，不得掛住等輸入、不得讀管道內容。`list`／`rm`／`test` 不受此限（C-3）。
async function keyCommand(argv: string[], lang: "en" | "zh"): Promise<void> {
  const command = getCommandName();
  const args = [...argv];
  let dbPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db") { dbPath = args[i + 1]; args.splice(i, 2); i--; }
  }
  const [action, ...rest] = args;
  if (action === "--help" || action === "-h") {
    console.log(m(lang, "keyHelp", command));
    return;
  }
  const db = openDbSeeded(dbPath, lang);

  if (action === "list") {
    const rows = buildKeyStatusRows(db);
    for (const row of rows) console.log(m(lang, "keyListRow", row.provider, keyStatusText(lang, row)));
    return;
  }

  if (action === "rm") {
    const [provider] = rest;
    if (!provider) throw new DispatchError(m(lang, "keyHelp", command), 2);
    assertKnownProvider(db, provider, lang);
    const removed = removeProviderKey(db, provider);
    console.log(m(lang, removed ? "keyRemoved" : "keyRemovedNotFound", provider));
    return;
  }

  if (action === "test") {
    const [provider] = rest;
    if (!provider) throw new DispatchError(m(lang, "keyTestHelp", command), 2);
    assertKnownProvider(db, provider, lang);
    await runKeyTest(db, provider, lang);
    return;
  }

  if (action !== undefined) throw new DispatchError(m(lang, "keyHelp", command), 2);

  // 免參數：互動選單（裁示 1：一個指令 ＋ 選單選 provider ＋ 貼上；裁示 3：不留非互動路徑）。
  if (!process.stdin.isTTY) {
    throw new DispatchError(m(lang, "keyInteractiveRequiresTty"), 2);
  }

  const rows = buildKeyStatusRows(db);
  console.log(m(lang, "keyMenuHeader"));
  const width = Math.max(...rows.map((row) => row.provider.length));
  rows.forEach((row, i) => {
    console.log(m(lang, "keyMenuRow", i + 1, row.provider.padEnd(width), keyStatusText(lang, row)));
  });

  const menuRl = createInterface({ input: process.stdin, output: process.stdout });
  const choiceRaw = (await menuRl.question(m(lang, "keyMenuPrompt", rows.length))).trim();
  menuRl.close();
  if (choiceRaw.toLowerCase() === "q") {
    console.log(m(lang, "keyMenuQuit"));
    return;
  }
  const choice = Number(choiceRaw);
  if (!Number.isInteger(choice) || choice < 1 || choice > rows.length) {
    throw new DispatchError(m(lang, "keyMenuInvalidChoice"), 2);
  }
  const provider = rows[choice - 1].provider;

  // C-1 要求 1：前後空白要 trim——貼上最常見的失敗是帶了尾隨空白或只貼到一半。
  const secret = (await readSecret(m(lang, "keyPastePrompt", provider))).trim();
  if (!secret) {
    console.log(m(lang, "keyPasteEmpty"));
    return;
  }
  const record = setProviderKey(db, provider, secret);
  console.log(m(lang, "keySavedTail", maskTail(record.apiKey)));
  // §D：這把剛存進 DB 的值必須立刻進遮罩名單——下面「要不要立即驗證」若真的呼叫 API，
  // 這把已經在 secretValues 裡，不會原樣寫進任何錯誤訊息。
  registerSecrets(listProviderKeys(db).map((k) => k.apiKey));

  // 裁示 2：不直接驗，存完問一句要不要立即驗；預設 N，跑之前明講會花錢（runKeyTest 自己會問）。
  const verifyRl = createInterface({ input: process.stdin, output: process.stdout });
  const verifyAnswer = (await verifyRl.question(m(lang, "keyVerifyPrompt", provider))).trim().toLowerCase();
  verifyRl.close();
  if (verifyAnswer === "y") {
    await runKeyTest(db, provider, lang);
  }
}

async function main() {
  // 0.5.0 起 main() 開頭不再做任何 key 相關的載入：沒有 `.env`、沒有環境變數來源
  // （見 dispatch-home.ts 檔頭）。`$DISPATCH_HOME` 仍是 DB 的預設落點，但由 defaultDbPath()
  // 自己解析；遮罩的註冊移到各個持有 db handle 的路徑上（openDbSeeded 之後）。

  // plan_i18n_impl_tickets T3：parseArgs 自己的解析期錯誤、以及 --help 本身的輸出，都發生在
  // resolveLang 判定出權威語言之前——這裡只能用「DISPATCH_LANG 有效就用它，否則內建預設 en」
  // 這個不會拋例外的簡化判定（resolveFallbackLang，見 cli-args.ts）。--lang 旗標的值在這個
  // 時間點還沒被驗證，不查它（v1.3 §二之2 #5／#6：help／version 的語言不受 --lang 影響）。
  const messageLang = resolveFallbackLang(process.env.DISPATCH_LANG);

  if (process.argv[2] === "ticket") {
    await ticketCommand(process.argv.slice(3), messageLang);
    return;
  }

  if (process.argv[2] === "providers") {
    await providersCommand(process.argv.slice(3), messageLang);
    return;
  }

  if (process.argv[2] === "token") {
    await tokenCommand(process.argv.slice(3), messageLang);
    return;
  }

  if (process.argv[2] === "key") {
    await keyCommand(process.argv.slice(3), messageLang);
    return;
  }

  if (process.argv[2] === "result") {
    const args = process.argv.slice(3);
    const positional: string[] = [];
    let dbPath: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--db") dbPath = args[++i];
      else positional.push(args[i]);
    }
    if (positional.length !== 1) throw new DispatchError(m(messageLang, "resultHelp", getCommandName()), 2);
    const db = openDbSeeded(dbPath, messageLang);
    const requestedId = positional[0];
    // `result` has three accepted identifiers.  Resolve an exact job id first, then an
    // exact ticket id, and only then a job-id prefix: exact identifiers must never be
    // reinterpreted as a shorter prefix when their text happens to collide.
    let resultId = requestedId;
    const exactJob = getJob(db, requestedId);
    if (exactJob) {
      resultId = exactJob.id;
    } else if (!db.prepare("SELECT 1 FROM tickets WHERE name = ?").get(requestedId)) {
      const candidates = findJobsByIdPrefix(db, requestedId);
      if (candidates.length > 1) {
        console.log(m(messageLang, "resultPrefixAmbiguous", requestedId, candidates.length));
        const idWidth = shortestDistinctIdWidth(candidates.map((job) => job.id));
        for (const job of candidates) console.log(m(messageLang, "resultCandidate", job.id.slice(0, idWidth), job.ticket, job.status));
        return;
      }
      if (candidates.length === 1) resultId = candidates[0].id;
    }
    // 驗收熱修補：失敗 spoke 的字樣先前固定英文（readResults 的 lang 有預設值而這裡沒傳），
    // 中文模式下會印出一段英文——違反「對使用者的字串一律走 messages.ts 中英兩套」。
    const lines = readResults(db, resultId, messageLang);
    if (lines.length === 0) throw new DispatchError(m(messageLang, "resultNotFound", requestedId), 2);
    console.log(lines.join("\n\n"));
    return;
  }

  if (process.argv[2] === "approve") {
    const args = process.argv.slice(3);
    const positional: string[] = [];
    let dbPath: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--db") dbPath = args[++i];
      else positional.push(args[i]);
    }
    if (positional.length > 1) throw new DispatchError(m(messageLang, "approveHelp", getCommandName()), 2);
    const db = openDbSeeded(dbPath, messageLang);
    const prefix = positional[0];
    const pending = prefix === undefined ? listPendingApprovalJobs(db) : findJobsByIdPrefix(db, prefix);
    if (prefix === undefined && pending.length === 0) {
      console.log(m(messageLang, "approveNoPending"));
      return;
    }
    if (pending.length > 1) {
      if (prefix === undefined) console.log(m(messageLang, "approveMultiplePending", pending.length));
      else console.log(m(messageLang, "approvePrefixAmbiguous", prefix, pending.length));
      // 熱修補：候選清單原本一律截到 8 碼，而歧義前綴的每一筆前 8 碼**必然相同**——
      // 訊息叫人「給長一點的 id」，列出來的卻正好是分不出來的那一段，照著做不到。
      // 改為取「足以在本次候選中互相區分」的長度，最少仍是 8。
      const idWidth = shortestDistinctIdWidth(pending.map((job) => job.id));
      for (const job of pending) console.log(m(messageLang, "approvePendingCandidate", job.id.slice(0, idWidth), job.ticket, job.created_at));
      return;
    }
    const before = pending[0];
    if (!before) throw new DispatchError(m(messageLang, "jobNotFound", prefix ?? ""), 2);
    // Render the complete paid-work summary before changing the gate state.
    // A corrupted job therefore stays pending instead of becoming approved with
    // no information shown to the human operator.
    const ticketSummary = formatTicket(db, before.ticket, messageLang);
    console.log(ticketSummary);
    const job = approveJob(db, before.id);
    if (!job) throw new DispatchError(m(messageLang, "jobNotApprovable", before.id, before.status), 2);
    console.log(m(messageLang, "jobApproved", job.id));
    return;
  }

  const parsed = parseArgs(process.argv.slice(2), messageLang);
  if (parsed.mode === "help") {
    console.log(m(messageLang, "helpText", getCommandName()));
    return;
  }
  if (parsed.mode === "version") {
    console.log(getPackageVersion());
    return;
  }
  if (parsed.mode === "doctor") {
    // 工單 W1 §一之2：語言走 messageLang（resolveFallbackLang），不受 --lang 影響——
    // --doctor 可能正是拿來診斷 --lang／DISPATCH_LANG 本身壞掉的工具。
    // §一之6：型號白名單走既有的 loadProviders／bundledProvidersPath，載入失敗印失敗原因、
    // 不中止（doctor 本身 exit 一律 0，見下方 buildDoctorReport 的呼叫沒有任何 throw 路徑）。
    let providersResult: DoctorProvidersResult;
    // 工單 key-db §B-3 #6：逐 provider 印出實際生效的是哪一層——doctorDb 開不起來時就沒有
    // DB 可查，keyStatusRows 留空陣列（buildApiKeyValue 對空陣列的降級輸出）。
    let keyStatusRows: KeyStatusRow[] = [];
    // A（gaps #1）：整份報表——DB、金鑰、型號白名單、daemon——都要來自**這次真的會用到的**
    // 那個 DB。先前這裡寫死 undefined／defaultDbPath()，於是 `--doctor --db <別的>` 印的
    // 全是預設 DB 的狀況，而使用者指定的那個檔連建都不會建。
    const doctorDbPath = parsed.options.dbPath ?? defaultDbPath();
    try {
      const doctorDb = openDbSeeded(doctorDbPath, messageLang);
      const providers = loadProviders(doctorDb, messageLang);
      providersResult = { ok: true, providers, models: listModels(doctorDb) };
      keyStatusRows = buildKeyStatusRows(doctorDb);
    } catch (err) {
      const reason = err instanceof DispatchError ? err.message : maskString(String(err));
      providersResult = { ok: false, reason };
    }
    const doctorData = buildDoctorReportData(
      getCommandName(),
      providersResult,
      process.env,
      undefined,
      undefined,
      undefined,
      daemonAlive(daemonStatePath(doctorDbPath)),
      keyStatusRows,
      doctorDbPath,
    );
    console.log(parsed.options.json ? JSON.stringify(doctorData) : renderDoctorReport(messageLang, getCommandName(), doctorData));
    return;
  }
  if (parsed.mode === "serve") {
    if (parsed.stop) {
      const outcome = await stopDaemon(parsed.options.dbPath, {
        force: parsed.options.yes,
        confirmRunningJobs: async (count) => {
          console.log(m(messageLang, "daemonStopRunningWarning", count));
          return confirm(m(messageLang, "daemonStopConfirmPrompt"), process.stdout);
        },
      });
      switch (outcome.status) {
        case "not_running":
          console.log(m(messageLang, "daemonStopNotRunning", outcome.reason));
          break;
        case "cancelled":
          console.log(m(messageLang, "daemonStopCancelled"));
          break;
        case "pid_not_dowafu":
          console.log(m(messageLang, "daemonStopPidNotDowafu", outcome.pid));
          break;
        case "signal_failed":
          console.log(m(messageLang, "daemonStopSignalFailed", outcome.pid));
          break;
        case "stopped":
          console.log(m(messageLang, "daemonStopSucceeded", outcome.pid));
          break;
        case "restarted":
          console.log(m(messageLang, "daemonStopRestarted", outcome.pid));
          break;
      }
      return;
    }
    try {
      const daemon = await serve(parsed.options.dbPath, undefined, parsed.options.httpPort, messageLang);
      console.log(m(messageLang, "daemonStarted"));
      console.log(m(messageLang, "httpServerStarted", daemon.httpPort));
      // B-1 #6：端點活著但沒發過 token，任何請求都進不來——失敗長得像成功，必須警告。
      if (!daemon.hasActiveToken) console.log(m(messageLang, "httpNoTokensWarning"));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new DispatchError(m(messageLang, "daemonStartFailed", detail), 2);
    }
    return;
  }
  if (parsed.mode === "mcp") {
    startStdioServer({ dbPath: parsed.options.dbPath, lang: messageLang });
    return;
  }

  const { ticketDir: ticketName, options } = parsed;
  const log = makeLogger(options.json);

  // plan_i18n_v1.3.md §二：--lang > DISPATCH_LANG > 內建預設，含九項組合判定
  // （fail closed，無效值 exit 2）。help／version 已在上面短路，不會走到這裡。
  //
  // T1 驗收帶出的第一條（T3 執行）：語言的權威來源只有這行的回傳值。CLI 層訊息一律用
  // 這個 lang，不得讀 options.langRaw——後者是未經 parseLang 驗證的原始字串，可能是
  // undefined 或未正規化的 "ZH-TW"，誤用會靜默走中文分支且 typecheck 不會紅。
  const lang = resolveLang(options.langRaw, process.env.DISPATCH_LANG);

  // v1.10 §9：--repo-root 只影響白名單邊界、.claude/agents 位置、_docs/ 拒絕判定；
  // 工單目錄仍相對 cwd 解析，不要求位於 repoRoot 內（見 resolveSpokes 呼叫處）。
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const ticketId = ticketName;
  const db = openDbSeeded(options.dbPath, lang);

  // §10 步驟 1–2：工單解析＋允許清單存在性（loadTicket／resolveSpokes 內部 fail closed）
  const ticket = await loadTicket(db, ticketName, lang);

  const providersSource: ProvidersSource = { kind: "database" };
  const providers = loadProviders(db, lang);

  // §10 步驟 4–5：effort 值域、API key 齊備、models 白名單（resolveSpokes 內部）。
  // 兩個回呼都是必填：validate.ts 不持有 db handle，「這個型號開著嗎」與「這個 provider
  // 有沒有 key」都由這裡接上——漏傳編不過（typecheck 涵蓋測試檔）。
  const spokes: ResolvedSpoke[] = await resolveSpokes(
    ticket,
    providers,
    repoRoot,
    lang,
    (provider, model) => isModelEnabled(db, provider, model),
    (provider) => getProviderKey(db, provider) !== undefined,
  );

  // §10 步驟 6／§14 閘門一：呼叫前估算
  const estimates: SpokeEstimate[] = spokes.map((spoke) => {
    const systemPrompt = buildSystemPrompt(spoke.agentBody, spoke.lang);
    const firstUserText = buildFirstUserText(
      ticket.ticketDir,
      spoke.agent,
      spoke.allowedReadsRelative,
      repoRoot,
      spoke.lang,
    );
    const charsPerToken = effectiveCharsPerToken(spoke, options);
    return {
      agent: spoke.agent,
      estimatedTokens: estimateTokens(systemPrompt, charsPerToken) + estimateTokens(firstUserText, charsPerToken),
    };
  });
  checkGateOne(estimates, options.maxTokens, lang);

  // plan_dispatch_v2.0.md §14：允許清單總量估算，獨立於閘門一之外，只呈現不設閘門
  // （閘門一不含允許清單內容，見 gate.ts 的說明）。與 estimates 同一模式：算一次，
  // 報表與 --json plan 共用，不重複讀檔。
  const allowlistEstimates: AllowlistEstimate[] = spokes.map((spoke) => ({
    agent: spoke.agent,
    estimatedTokens: estimateAllowlistTokens(spoke.allowedReadsContent ?? [], effectiveCharsPerToken(spoke, options)),
    fileCount: spoke.allowedReadsResolved.length,
    sequential: estimateSequentialRead(spoke.allowedReadsContent ?? [], effectiveCharsPerToken(spoke, options)),
  }));

  const resultId = options.jobId ?? ticketId;
  const outDir = `db:${resultId}`;

  // 票 cost-cap §E #1：outDir（`db:<id>`）是假路徑，git 永遠判不出結果——舊碼因此寫死
  // "unknown" 並印出編出來的理由（「not a git repo, or git unavailable」，沒有人去檢查）。
  // 產物已搬進 DB（v1.11 §24.5），真正該檢查的是資料庫檔案本身的位置：`--db` 可以指到
  // repo 裡面，這樣才問得出「派工產物會不會被誤 commit」這個問題原本想問的事。
  const resolvedDbPath = options.dbPath ?? defaultDbPath();
  const gitignoreStatus = checkGitignore(resolvedDbPath);

  // v1.11 §25：plan 在此刻（步驟 6 之後）已完全確定，與是否實際執行無關——dry-run／
  // cancelled／executed 三種 mode 的 --json 輸出皆含同一份 plan。
  const plan = buildJsonPlan(spokes, estimates, allowlistEstimates, options);
  const buildPayload = (
    mode: "dry-run" | "cancelled" | "executed",
    results: SpokeRunResult[],
    audits: Map<string, ReturnType<typeof auditSpoke>>,
    toolCallAudits: Map<string, ToolCallAudit>,
    exitCode: number,
  ) =>
    buildJsonPayload({
      ticketId,
      repoRoot,
      outDir,
      providersSource,
      mode,
      plan,
      gitignoreStatus,
      results,
      audits,
      toolCallAudits,
      exitCode,
    });

  // §10 步驟 7／§11：派工報表
  const report = buildReport(
    ticketId,
    spokes,
    estimates,
    allowlistEstimates,
    options,
    outDir,
    {
      repoRoot,
      providersSource,
      gitignoreStatus,
      dbPath: resolvedDbPath,
      reviewTextChars: ticket.shared.reviewText.length,
      strayHeadings: ticket.shared.strayHeadings,
    },
    lang,
  );
  log.info(report);

  // 護欄的預告：乾跑不受影響（它不寫任何東西），但先講，免得實跑才發現被擋。
  const alreadyRun = hasResults(db, resultId);

  if (options.dryRun) {
    if (alreadyRun) log.info("\n" + m(lang, "resultsExistDryRunWarning", resultId));
    log.info("\n" + m(lang, "dryRunNotice"));
    if (options.json) {
      console.log(JSON.stringify(maskDeep(buildPayload("dry-run", [], new Map(), new Map(), 0))));
    }
    return;
  }

  // 擋在 confirm 之前：不要先問「要不要花錢」再中止。exitCode 5 是「派工前被守則擋下、
  // 未花任何錢」，與 3（成本閘門超限）分開，才分得出是哪一種擋。
  // **刻意不提供 --overwrite 之類的旗標**：有旗標，「加上去」就會變成最便宜的滿足方式，
  // 那正是 --yes 已經示範過的路。要覆蓋，由使用者自己把那筆結果從 DB 刪掉。
  if (alreadyRun) {
    throw new DispatchError(m(lang, "resultsExistAbort", resultId), 5);
  }

  if (!options.yes) {
    const ok = await confirm(m(lang, "confirmPrompt"), options.json ? process.stderr : process.stdout);
    if (!ok) {
      log.info(process.stdin.isTTY ? m(lang, "cancelledInteractive") : m(lang, "cancelledNonInteractive"));
      if (options.json) {
        console.log(JSON.stringify(maskDeep(buildPayload("cancelled", [], new Map(), new Map(), 0))));
      }
      return;
    }
  }

  const semaphore = new Semaphore(options.concurrency);

  const onEvent = (event: RunEvent) => {
    log.info(formatEvent(event, lang));
    // B（gaps #6）：這串事件的第二個消費者。`RunLogWriter` 曾經是它（寫 run.jsonl），
    // 票 B 退場之後 DB 這側就沒人接，於是跑的過程中完全沒有可查的進度。
    // recordRound 自己吞掉所有例外——進度查不到，也不該弄死一次已付費的派工。
    if (event.type === "round") recordRound(db, resultId, event.agent, event.round, event.usage, event.hasToolCalls);
  };

  // §10 步驟 8：信號量控制發起，Promise.allSettled 只負責收尾
  const settled = await Promise.allSettled(
    spokes.map(async (spoke) => {
      await semaphore.acquire();
      try {
        const adapter = createAdapterFor(spoke, db);
        const result = await runSpoke(spoke, adapter, ticket.ticketDir, {
          repoRoot,
          timeoutMs: options.timeoutSec * 1000,
          retries: options.retries,
          rateLimitRetries: options.rateLimitRetries,
          maxRateWaitSec: options.maxRateWaitSec,
          maxToolCalls: options.maxToolCalls,
          maxSpokeTokens: effectiveCap(spoke, options),
          maxSpokeReasoningTokens: options.maxSpokeReasoningTokens,
          maxRoundReasoningTokens: options.maxRoundReasoningTokens,
          charsPerToken: effectiveCharsPerToken(spoke, options),
          semaphore,
          onEvent,
        });
        // §13（一）：每支 spoke 完成即落檔，不等 Promise.allSettled——多 spoke 並行、
        // 其中一支慢很多時，快的那支已付費的產出不因慢的還在跑而暴露在中斷風險下。
        try {
          persistSpokeResultDb(db, resultId, result);
        } catch (err) {
          // 落檔失敗不得把已付費 result 變成 allSettled 的 rejected 假結果；結算後的
          // 重試迴圈會再以同一份真實 result 補寫。仍須以 stderr 留痕，不能靜默吞掉。
          console.error(m(lang, "dbResultPersistenceFailed", result.agent, maskString(String(err))));
        }
        return result;
      } finally {
        semaphore.release();
      }
    }),
  );

  const results: SpokeRunResult[] = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    // §13：runSpoke 會把已知 spoke 錯誤收斂為 status:"failed"；這裡仍保留給 adapter
    // 建立等 runSpoke 之外的例外。每支的 DB 落檔錯誤已在上方接住並保留真實 result。
    const spoke = spokes[i];
    return {
      agent: spoke.agent,
      provider: spoke.provider,
      api: spoke.providerConfig.api,
      modelRequested: spoke.model,
      modelReturned: null,
      effort: spoke.effort,
      store: "unknown",
      status: "failed",
      finalText: null,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: false },
      costUsd: null,
      finishReason: null,
      finishReasonRaw: null,
      toolCalls: [],
      rateLimitHits: [],
      unknownUsageKeys: [],
      attempts: 0,
      errors: [maskString(String(s.reason))],
      requestId: null,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      latencyMs: 0,
      waitedMs: 0,
      estimatedPromptTokens: 0,
      rawRequests: [],
      rawResponses: [],
      rawErrors: [],
    } satisfies SpokeRunResult;
  });

  // §10 步驟 9：確定性稽核
  const audits = new Map(results.map((r) => [r.agent, auditSpoke(r.finalText)] as const));
  // plan_dispatch_v2.0.md §15（一）：tool 呼叫是執行資料不是文字，獨立於 auditSpoke 之外判定。
  const toolCallAudits = new Map(
    results.map((r) => {
      const spoke = spokes.find((sp) => sp.agent === r.agent)!;
      return [r.agent, auditToolCalls(r.agent, r.toolCalls, spoke.allowedReadsRelative.length)] as const;
    }),
  );

  // §10 步驟 10：落檔 + stdout 摘要。這裡的迴圈定位已改變（v2.4 §13 規格二）：
  // per-spoke 落檔已在 spokes.map 內完成，此處是「落檔失敗的重試」，不再是
  // rejected 分支的兜底——真實 result 的完全相同重寫由 DB helper 視為冪等。
  for (const r of results) persistSpokeResultDb(db, resultId, r);
  writeSummaryDb(db, resultId, results, audits, toolCallAudits, lang);
  log.info("\n" + m(lang, "resultsSaved", resultId));

  const allFailed = results.every((r) => r.status === "failed");
  const exitCode = allFailed ? 4 : 0;
  if (allFailed) {
    process.exitCode = exitCode;
  }

  if (options.json) {
    console.log(JSON.stringify(maskDeep(buildPayload("executed", results, audits, toolCallAudits, exitCode))));
  } else {
    log.info("\n" + buildStdoutSummary(results, lang));
  }
}

// 熱修補（票 key-visibility 驗收）：這個守衛存在的理由是 B-0——測試要 import
// `executeKeyTest` 而不觸發 main()。但它原本用 `path.resolve` 比對，而 **resolve 不解析
// symlink**，`import.meta.url` 卻是 Node 解析過的真實路徑。於是經由 symlink 呼叫時兩邊
// 永遠不相等，main() 不執行——**CLI 靜默什麼都不做，還 exit 0**。
//
// 那正是 `npm install -g dowafu`（README 教的安裝方式）的形態：npm 在 node_modules/.bin
// 建的是 symlink。daemon 與 MCP stdio 都用絕對真實路徑 spawn，pnpm 的 shim 傳的又是帶 `..`
// 的相對路徑（resolve 後恰好相等），所以三個現有驗證面全都測不到它。
//
// realpathSync 會 throw（檔案不存在、權限不足），那時退回原本的 resolve 比對——
// 判斷不出來就寧可執行，不要靜默不執行。
function isDirectExecution(entry: string): boolean {
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === self;
  } catch {
    return path.resolve(entry) === self;
  }
}

if (process.argv[1] && isDirectExecution(process.argv[1])) {
  main().catch((err) => {
    if (err instanceof DispatchError) {
      console.error(maskString(err.message));
      process.exitCode = err.exitCode;
      return;
    }
    console.error(maskString(String(err)));
    process.exitCode = 1;
  });
}
