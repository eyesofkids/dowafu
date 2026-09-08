// D1: the only module that knows about SQLite.  Keep all schema and driver details here.
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveDispatchHome } from "./dispatch-home.js";
import { DispatchError, type Lang } from "./types.js";
import { m } from "./messages.js";

let warningFilterInstalled = false;

export function installSqliteWarningFilter(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;
  const listeners = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) return;
    for (const listener of listeners) listener(warning);
  });
}

// The warning is emitted as node:sqlite is loaded, so the filter must exist before
// the runtime import (a static import is too early for that ordering).
installSqliteWarningFilter();
const { DatabaseSync: DatabaseSyncDriver } = await import("node:sqlite");

export function defaultDbPath(): string {
  const home = resolveDispatchHome();
  return process.env.DOWAFU_DB ?? path.join(home ?? process.cwd(), "dowafu.db");
}

// T0: schema versioning lives in SQLite's own `user_version` header field rather than a
// table of our own — one less thing to create before we can ask "which version is this".
//
// Every step must be safe to re-run: a DB written before T0 sits at user_version 0 while
// already holding the D1 tables, so step 1 has to be a no-op for it.  `CREATE TABLE IF NOT
// EXISTS` gives that for free.  Future steps that *cannot* be expressed idempotently —
// `ALTER TABLE jobs ADD COLUMN budget_id` is the one already on the horizon — are exactly
// why the counter exists: `IF NOT EXISTS` silently skips a table that is present but missing
// a column, so the column would never appear on an upgraded DB and the failure would surface
// as a runtime `no such column` on someone else's machine.
type Migration = { version: number; up: (db: DatabaseSync) => void };

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tickets (
          name TEXT PRIMARY KEY,
          doc TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          ticket TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          approved_at TEXT,
          claimed_at TEXT,
          heartbeat_at TEXT,
          finished_at TEXT,
          error TEXT,
          cost_usd REAL
        );
        CREATE TABLE IF NOT EXISTS results (
          job_id TEXT NOT NULL,
          agent TEXT NOT NULL,
          output TEXT,
          request TEXT,
          response TEXT,
          tokens_in INTEGER,
          tokens_out INTEGER,
          cost_usd REAL,
          PRIMARY KEY (job_id, agent)
        );

        -- providers/models mirror providers.json's two levels instead of flattening them.
        -- Flattening would repeat every provider-level field on each model row, and the
        -- import merge would then have to reconcile rows of the same provider disagreeing.
        -- 'reasoning' and 'pricing_source' stay as JSON text: they are nested config that
        -- is read whole, never filtered on.
        CREATE TABLE IF NOT EXISTS providers (
          name TEXT PRIMARY KEY,
          base_url TEXT NOT NULL,
          api TEXT NOT NULL,
          store INTEGER,
          tool_calling INTEGER NOT NULL,
          reasoning TEXT NOT NULL,
          chars_per_token REAL,
          tpm_limit INTEGER,
          max_spoke_tokens INTEGER,
          pricing_source TEXT,
          updated_at TEXT NOT NULL
        );
        -- One row per model serves both roles providers.json splits across 'models[]' and
        -- 'pricing{}': the row's existence is the whitelist, its price columns are the
        -- pricing, and 'enabled' is the new gate.  Price columns stay nullable because a
        -- whitelisted model may have no pricing data — "cannot estimate" and "costs zero"
        -- must remain distinguishable (see cost.ts).
        CREATE TABLE IF NOT EXISTS models (
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input_per_m REAL,
          cached_input_per_m REAL,
          cache_write_per_m REAL,
          output_per_m REAL,
          enabled INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (provider, model)
        );
        -- Inbound HTTP credentials.  Only ever compared, never replayed, so the hash is
        -- all we keep.  Provider API keys are the opposite case and deliberately do not
        -- share this table: they have to be handed to the vendor verbatim.
        CREATE TABLE IF NOT EXISTS tokens (
          id TEXT PRIMARY KEY,
          hash TEXT NOT NULL,
          label TEXT,
          created_at TEXT NOT NULL,
          revoked_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_ticket_status ON jobs (ticket, status);
        CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
        CREATE INDEX IF NOT EXISTS idx_models_enabled ON models (enabled);
      `);
    },
  },
  // T1 (E12): outbound provider API keys.  Deliberately NOT the `tokens` table — that one
  // holds *inbound* HTTP credentials and stores only a hash, while these have to be handed
  // back in cleartext to call the provider.  Opposite storage requirements, separate tables.
  //
  // Stored in cleartext, and that is the decision on record (decision_mcp.md E12): the win
  // here is operational (set once via CLI, no file to chmod, works on Windows), not security
  // — a SQLite file is as readable as the .env it replaces.  Do not add encryption that
  // would only look like protection.
  {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS provider_keys (
          provider   TEXT PRIMARY KEY,
          api_key    TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  // B（gaps #6）：跑的過程中看得到進度。`results` 每支 spoke 只在**跑完的那一刻**寫一次，
  // 所以單支 spoke 的工單在跑完之前完全沒有訊號——最壞安靜十分鐘，而 skill 只能寫
  // 「安靜不代表當掉」。這張表補的就是那段空白。
  //
  // **每輪 append 一列，不是 update 一列。** 「哪一輪慢」是 `RunLogWriter` 退場時明文記為
  // 降級的四項之一（_archived/log.md §七），逐列才留得住輪級時間戳；更新同一列只留得下
  // 最後一輪。列數上限是 maxToolCalls（20）＋1，代價可以忽略。
  //
  // **這張表刻意與 `results` 分開。** `results` 是寫一次的已付費產出，`persistSpokeResultDb`
  // 對「實質不同的重寫」會撞 primary-key constraint 炸出來——那是 D1-hot3 為了
  // 「落檔失敗不得銷毀已付費結果」建的守衛。逐輪寫進度本質上就是「每次都不一樣的寫入」，
  // 混進去會正面撞上它。進度是可丟棄的診斷資料，兩者的耐久性要求本來就不同。
  //
  // 欄位用 `result_id` 而不是比照 `results` 的 `job_id`：那一欄存的其實是
  // `jobId ?? ticketId`（前景直接跑 CLI 時沒有 job），叫 job_id 是既有的名實不符，
  // 新表不跟進。**用同一個值當 key，所以前景那條路也拿得到進度。**
  {
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS progress (
          result_id      TEXT NOT NULL,
          agent          TEXT NOT NULL,
          round          INTEGER NOT NULL,
          at             TEXT NOT NULL,
          tokens_in      INTEGER NOT NULL,
          tokens_out     INTEGER NOT NULL,
          has_tool_calls INTEGER NOT NULL,
          PRIMARY KEY (result_id, agent, round)
        );
      `);
    },
  },
  // key-visibility §B：key 本身更新的時間不能冒充「最後驗證」；三個 nullable 欄位把
  // 從未測過、測過成功、測過失敗分開。正常升級只會對 v3 DB 跑一次，但檢查既有欄位，
  // 仍讓中斷後重跑或測試回退的 migration 安全，不把 ALTER TABLE 當成有 IF NOT EXISTS。
  {
    version: 4,
    up: (db) => {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(provider_keys)").all() as Array<{ name: string }>).map((column) => column.name),
      );
      if (!columns.has("last_tested_at")) db.exec("ALTER TABLE provider_keys ADD COLUMN last_tested_at TEXT");
      if (!columns.has("last_test_model")) db.exec("ALTER TABLE provider_keys ADD COLUMN last_test_model TEXT");
      if (!columns.has("last_test_succeeded")) db.exec("ALTER TABLE provider_keys ADD COLUMN last_test_succeeded INTEGER");
    },
  },
];

const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function migrate(db: DatabaseSync, lang: Lang): void {
  const current = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  // Fail closed on a DB written by a newer dowafu.  Carrying on would mean an older binary
  // reading a schema it does not know, which reads as working right up until it does not.
  if (current > LATEST_SCHEMA_VERSION) {
    throw new DispatchError(m(lang, "dbSchemaTooNew", current, LATEST_SCHEMA_VERSION), 2);
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec("BEGIN");
    try {
      migration.up(db);
      // PRAGMA takes no bound parameters; the value is an integer literal from MIGRATIONS.
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export function openDb(dbPath: string = defaultDbPath(), lang: Lang = "en"): DatabaseSync {
  installSqliteWarningFilter();
  if (dbPath !== ":memory:") mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new DatabaseSyncDriver(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db, lang);
  return db;
}

export { LATEST_SCHEMA_VERSION };

export const now = (): string => new Date().toISOString();
