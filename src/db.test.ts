import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LATEST_SCHEMA_VERSION, openDb } from "./db.js";
import { addAllow, addSpoke, createTicket, getTicketDoc } from "./ticket-store.js";
import { DispatchError } from "./types.js";
import { m } from "./messages.js";

function withTempDb(run: (dbPath: string, root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), "dowafu-db-"));
  return run(path.join(root, "dowafu.db"), root).finally(() => rmSync(root, { recursive: true, force: true }));
}

const SHARED = "# 待審段落\n內容\n";
const BODY = "# 具體問題\n1. 問題\n\n# 允許讀取\n- source.txt\n";

function seedModel(db: ReturnType<typeof openDb>, provider = "openai", model = "gpt-5.6-luna"): void {
  db.prepare("INSERT INTO providers (name, base_url, api, store, tool_calling, reasoning, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(provider, "https://example.test", "responses", 0, 1, JSON.stringify({ style: "openai", allowed: ["low"], default: "low" }), "2026-09-02T00:00:00.000Z");
  db.prepare("INSERT INTO models (provider, model, enabled, updated_at) VALUES (?, ?, ?, ?)").run(provider, model, 1, "2026-09-02T00:00:00.000Z");
}

test("D1：建表後建立工單、加 spoke 與允許清單時快照內容", async () => {
  await withTempDb(async (dbPath, root) => {
    writeFileSync(path.join(root, "source.txt"), "first snapshot");
    const db = openDb(dbPath);
    seedModel(db);
    createTicket(db, "sample", SHARED, "zh");
    addSpoke(db, "sample", { agent: "hole-finder-cost", provider: "openai", model: "gpt-5.6-luna", body: BODY }, "zh");
    await addAllow(db, "sample", "hole-finder-cost", "source.txt", root, "zh");
    writeFileSync(path.join(root, "source.txt"), "changed on disk");
    assert.equal(getTicketDoc(db, "sample", "zh").spokes[0].allow[0].content, "first snapshot");
    assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  });
});

test("D1：允許清單在加入時拒絕不存在的路徑", async () => {
  await withTempDb(async (dbPath, root) => {
    const db = openDb(dbPath);
    seedModel(db);
    createTicket(db, "sample", SHARED, "zh");
    addSpoke(db, "sample", { agent: "hole-finder-cost", provider: "openai", model: "gpt-5.6-luna", body: BODY }, "zh");
    await assert.rejects(addAllow(db, "sample", "hole-finder-cost", "missing.txt", root, "zh"), DispatchError);
  });
});

test("D1：允許清單在加入時拒絕真的存在於 _docs 的檔案", async () => {
  await withTempDb(async (dbPath, root) => {
    const db = openDb(dbPath);
    seedModel(db);
    createTicket(db, "sample", SHARED, "zh");
    addSpoke(db, "sample", { agent: "hole-finder-cost", provider: "openai", model: "gpt-5.6-luna", body: BODY }, "zh");
    mkdirSync(path.join(root, "_docs"));
    writeFileSync(path.join(root, "_docs", "existing.md"), "must stay forbidden");
    await assert.rejects(
      addAllow(db, "sample", "hole-finder-cost", "_docs/existing.md", root, "zh"),
      (err: unknown) => err instanceof DispatchError && err.message === m("zh", "allowedReadsUnderDocs", "hole-finder-cost", "_docs/existing.md"),
    );
  });
});

test("D1：同一 DB 工單不可加入重複 agent", async () => {
  await withTempDb(async (dbPath) => {
    const db = openDb(dbPath);
    seedModel(db);
    createTicket(db, "sample", SHARED, "zh");
    const spoke = { agent: "hole-finder-cost", provider: "openai", model: "gpt-5.6-luna", body: BODY };
    addSpoke(db, "sample", spoke, "zh");
    assert.throws(() => addSpoke(db, "sample", spoke, "zh"), DispatchError);
  });
});

// --- T0: schema versioning, new tables, indexes ---

function tableNames(db: ReturnType<typeof openDb>): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map((r) => r.name)
    .sort();
}

function schemaVersion(db: ReturnType<typeof openDb>): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

test("T0：新開的 DB 建出七張表與索引，並記下 schema 版本", async () => {
  await withTempDb(async (dbPath) => {
    const db = openDb(dbPath);
    for (const t of ["tickets", "jobs", "results", "providers", "models", "tokens", "provider_keys"]) {
      assert.ok(tableNames(db).includes(t), `缺少資料表 ${t}`);
    }
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>)
      .map((r) => r.name);
    for (const i of ["idx_jobs_ticket_status", "idx_jobs_status", "idx_models_enabled"]) {
      assert.ok(indexes.includes(i), `缺少索引 ${i}`);
    }
    assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION);
  });
});

test("T0：重複開啟同一個 DB 是冪等的", async () => {
  await withTempDb(async (dbPath) => {
    openDb(dbPath).close();
    const db = openDb(dbPath);
    assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION);
    assert.equal(tableNames(db).length, 8);
  });
});

test("ticket-states：v5 既有工單遷移為 draft，連開三次仍停在 schema 6", async () => {
  await withTempDb(async (dbPath) => {
    const { DatabaseSync } = await import("node:sqlite");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec("CREATE TABLE tickets (name TEXT PRIMARY KEY, doc TEXT NOT NULL, created_at TEXT NOT NULL)");
    legacy.prepare("INSERT INTO tickets (name, doc, created_at) VALUES (?, ?, ?)")
      .run("old-ticket", JSON.stringify({ shared: "old", spokes: [] }), "2026-09-12T00:00:00.000Z");
    legacy.exec("PRAGMA user_version = 5");
    legacy.close();

    for (let i = 0; i < 3; i++) {
      const db = openDb(dbPath, "en");
      assert.equal(schemaVersion(db), 6);
      const row = db.prepare("SELECT status, sealed_at FROM tickets WHERE name = ?").get("old-ticket") as { status: string; sealed_at: string | null };
      assert.equal(row.status, "draft");
      assert.equal(row.sealed_at, null);
      db.close();
    }
  });
});

// 這是遷移機制存在的理由：T0 之前建立的 DB 已經有 D1 那三張表，而 user_version 還是 0。
// 沒有這個機制，新表對它永遠不會出現，症狀只在「升級過的使用者」身上發生。
test("T0：T0 之前建立的舊 DB 再開啟時補上新表，既有資料不動", async () => {
  await withTempDb(async (dbPath) => {
    const { DatabaseSync } = await import("node:sqlite");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE tickets (name TEXT PRIMARY KEY, doc TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE jobs (id TEXT PRIMARY KEY, ticket TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
        approved_at TEXT, claimed_at TEXT, heartbeat_at TEXT, finished_at TEXT, error TEXT, cost_usd REAL);
      CREATE TABLE results (job_id TEXT NOT NULL, agent TEXT NOT NULL, output TEXT, request TEXT, response TEXT,
        tokens_in INTEGER, tokens_out INTEGER, cost_usd REAL, PRIMARY KEY (job_id, agent));
    `);
    legacy.prepare("INSERT INTO tickets (name, doc, created_at) VALUES (?, ?, ?)").run("kept", "{}", "2026-09-01T00:00:00.000Z");
    assert.equal(Number((legacy.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), 0);
    legacy.close();

    const db = openDb(dbPath);
    assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION);
    assert.ok(tableNames(db).includes("models"));
    assert.equal((db.prepare("SELECT doc FROM tickets WHERE name = ?").get("kept") as { doc: string }).doc, "{}");
  });
});

// T1：遷移機制第一次真的用來「把一張表加到已經升級過的 DB」。上一條走的是 0 → 最新
// （T0 之前的 DB，D1 那三張表已在），這條走的是 1 → 2——跑過 v0.5.0 的使用者。
// 兩者是不同的分支：上一條通過不代表這一條通過，而 1 → 2 才是實際會發生在別人機器上的那個。
test("T1：user_version 為 1 的 DB 再開啟時補上 provider_keys，既有資料不動", async () => {
  await withTempDb(async (dbPath) => {
    const seeded = openDb(dbPath);
    seeded.prepare("INSERT INTO tickets (name, doc, created_at) VALUES (?, ?, ?)").run("kept", '{"spokes":[]}', "2026-09-05T00:00:00.000Z");
    // 倒回 v0.5.0 出貨時的狀態：六張表、user_version = 1、還沒有 provider_keys。
    seeded.exec("DROP TABLE provider_keys");
    seeded.exec("PRAGMA user_version = 1");
    seeded.close();

    const db = openDb(dbPath);
    assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION);
    assert.ok(tableNames(db).includes("provider_keys"), "1 → 2 的遷移沒有補上 provider_keys");
    assert.equal((db.prepare("SELECT doc FROM tickets WHERE name = ?").get("kept") as { doc: string }).doc, '{"spokes":[]}');
  });
});

// B（gaps #6）：與上面那條 T1 同型，而且是同一個理由——**這條是「把新表塞進舊 version」
// 唯一會抓到的測試**。T1 當初做過那個變異：把建表塞進 version 1，11 條裡只有 1 條紅，
// 新建的 DB 一路綠，只有「已經是 v1 的 DB 升級」那條抓得到。
// 使用者自己那顆 ~/.config/dowafu/dowafu.db 現在正是 user_version = 2 且有真實資料——
// progress 若塞進 v2，他的機器上不會建表，症狀是執行期 no such table，而且只在他那裡發作。
test("B：user_version 為 2 的 DB 再開啟時補上 progress，既有資料不動", async () => {
  await withTempDb(async (dbPath) => {
    const seeded = openDb(dbPath);
    seeded.prepare("INSERT INTO tickets (name, doc, created_at) VALUES (?, ?, ?)").run("kept", '{"spokes":[]}', "2026-09-07T00:00:00.000Z");
    // 倒回 B 之前的狀態：七張表、user_version = 2、還沒有 progress。
    seeded.exec("DROP TABLE progress");
    seeded.exec("PRAGMA user_version = 2");
    seeded.close();

    const db = openDb(dbPath);
    assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION);
    assert.ok(tableNames(db).includes("progress"), "2 → 3 的遷移沒有補上 progress");
    assert.equal((db.prepare("SELECT doc FROM tickets WHERE name = ?").get("kept") as { doc: string }).doc, '{"spokes":[]}');
  });
});

test("key-visibility：user_version 為 3 的 DB 升級到 v4 時保留 key 並補上可重複讀取的測試欄位", async () => {
  await withTempDb(async (dbPath) => {
    const seeded = openDb(dbPath);
    seeded.prepare("INSERT INTO provider_keys (provider, api_key, created_at, updated_at) VALUES (?, ?, ?, ?)").run("openai", "preserved-key", "2026-09-08T00:00:00.000Z", "2026-09-08T00:00:00.000Z");
    seeded.exec("ALTER TABLE provider_keys DROP COLUMN last_test_succeeded");
    seeded.exec("ALTER TABLE provider_keys DROP COLUMN last_test_model");
    seeded.exec("ALTER TABLE provider_keys DROP COLUMN last_tested_at");
    seeded.exec("PRAGMA user_version = 3");
    seeded.close();

    const db = openDb(dbPath);
    assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION);
    const row = db.prepare("SELECT api_key, last_tested_at, last_test_model, last_test_succeeded FROM provider_keys WHERE provider = ?").get("openai") as {
      api_key: string; last_tested_at: string | null; last_test_model: string | null; last_test_succeeded: number | null;
    };
    assert.equal(row.api_key, "preserved-key");
    assert.equal(row.last_tested_at, null);
    assert.equal(row.last_test_model, null);
    assert.equal(row.last_test_succeeded, null);
    db.close();

    const reopened = openDb(dbPath);
    assert.equal(schemaVersion(reopened), LATEST_SCHEMA_VERSION, "v4 再開一次不得重跑 ALTER TABLE");
  });
});

test("queue-lang-rerun：v5 補 jobs.lang、保留舊 job，且欄位已在時可由版本回退重跑", async () => {
  await withTempDb(async (dbPath) => {
    const seeded = openDb(dbPath);
    seeded.prepare("INSERT INTO tickets (name, doc, created_at) VALUES (?, ?, ?)").run("kept", '{"spokes":[]}', "2026-09-09T00:00:00.000Z");
    seeded.prepare("INSERT INTO jobs (id, ticket, status, created_at) VALUES (?, ?, ?, ?)").run("old-job", "kept", "pending_approval", "2026-09-09T00:00:00.000Z");
    seeded.exec("ALTER TABLE jobs DROP COLUMN lang");
    seeded.exec("PRAGMA user_version = 4");
    seeded.close();

    const migrated = openDb(dbPath);
    assert.equal(schemaVersion(migrated), LATEST_SCHEMA_VERSION);
    assert.deepEqual(
      { ...(migrated.prepare("SELECT id, ticket, lang FROM jobs WHERE id = ?").get("old-job") as { id: string; ticket: string; lang: string | null }) },
      { id: "old-job", ticket: "kept", lang: null },
    );
    // Simulate a rollback fixture whose v5 column survived while its header was reset.
    migrated.exec("PRAGMA user_version = 4");
    migrated.close();
    const rerun = openDb(dbPath);
    assert.equal(schemaVersion(rerun), LATEST_SCHEMA_VERSION);
    assert.equal((rerun.prepare("SELECT lang FROM jobs WHERE id = ?").get("old-job") as { lang: string | null }).lang, null);
  });
});

// 主鍵是 provider，不是自動遞增的列 id——「一個 provider 一把」是 A-1 的設計，
// 由 schema 保障而不是靠呼叫端自律。票 key-db 的「重複 set 是更新不是新增」靠這條成立。
test("T1：provider_keys 的主鍵是 provider，同一家插兩次會衝突", async () => {
  await withTempDb(async (dbPath) => {
    const db = openDb(dbPath);
    const insert = "INSERT INTO provider_keys (provider, api_key, created_at, updated_at) VALUES (?, ?, ?, ?)";
    db.prepare(insert).run("openai", "test-key-abc123xyz", "2026-09-05T00:00:00.000Z", "2026-09-05T00:00:00.000Z");
    assert.throws(() => db.prepare(insert).run("openai", "test-key-other", "2026-09-05T00:00:00.000Z", "2026-09-05T00:00:00.000Z"));
    const row = db.prepare("SELECT api_key FROM provider_keys WHERE provider = ?").get("openai") as { api_key: string };
    assert.equal(row.api_key, "test-key-abc123xyz");
  });
});

test("T0：DB 的 schema 版本比本版新時，拒絕開啟而不是照常跑", async () => {
  await withTempDb(async (dbPath) => {
    openDb(dbPath).close();
    const { DatabaseSync } = await import("node:sqlite");
    const future = new DatabaseSync(dbPath);
    future.exec(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    future.close();
    assert.throws(
      () => openDb(dbPath),
      (err: unknown) =>
        err instanceof DispatchError && err.message === m("en", "dbSchemaTooNew", LATEST_SCHEMA_VERSION + 1, LATEST_SCHEMA_VERSION),
    );
  });
});

test("T0：models.enabled 預設是關的", async () => {
  await withTempDb(async (dbPath) => {
    const db = openDb(dbPath);
    db.prepare("INSERT INTO models (provider, model, updated_at) VALUES (?, ?, ?)").run("openai", "gpt-5.6-luna", "2026-09-02T00:00:00.000Z");
    assert.equal((db.prepare("SELECT enabled FROM models WHERE model = ?").get("gpt-5.6-luna") as { enabled: number }).enabled, 0);
  });
});
