import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { m } from "./messages.js";
import { getCommandName } from "./pkg-info.js";
import { openDb } from "./db.js";
import { importTicketDirectory } from "./ticket-store.js";
import { DispatchError } from "./types.js";

const entry = fileURLToPath(new URL("./cli.ts", import.meta.url));
function runCli(args: string[], root: string, lang: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry, ...args], {
      env: { ...process.env, DISPATCH_HOME: root, DISPATCH_LANG: lang, DOWAFU_HTTP_PORT: "7399" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

for (const command of ["result", "approve"] as const) {
  for (const flag of ["--help", "-h"]) {
    test(`${command} ${flag}: exact localized stdout, exit 0, no DB opened`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), "collisions-help-"));
      try {
        for (const lang of ["en", "zh"] as const) {
          // A nonexistent default home must remain empty; an explicit DB whose parent
          // is a regular file additionally proves this path cannot even be opened.
          const defaultRun = await runCli([command, flag], root, lang);
          assert.equal(defaultRun.code, 0, defaultRun.stderr);
          assert.equal(defaultRun.stdout, m(lang, `${command}Help`, getCommandName()) + "\n");
          assert.deepEqual(readdirSync(root), []);
          const blocker = path.join(root, "not-a-directory");
          writeFileSync(blocker, "block DB opening");
          try {
            const explicit = await runCli([command, flag, "--db", path.join(blocker, "db")], root, lang);
            assert.equal(explicit.code, 0, explicit.stderr);
            assert.equal(explicit.stdout, defaultRun.stdout);
            assert.doesNotMatch(explicit.stdout + explicit.stderr, /seeded|providers table was empty/i);
          } finally { rmSync(blocker); }
        }
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}

function fixture(root: string) {
  writeFileSync(path.join(root, "_shared.md"), "# Under review\nbody\n");
  writeFileSync(path.join(root, "_dispatch.md"), "<!-- format: v1 -->\n| agent | provider | model | effort |\n| --- | --- | --- | --- |\n| reviewer | deepseek | deepseek-v4-flash | |\n");
}

test("import uses the same reserved-name check before writing a ticket", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "collisions-import-"));
  const db = openDb(":memory:");
  try {
    fixture(root);
    for (const name of ["ticket", "providers", "token", "key", "result", "approve", "serve", "mcp", "-h", "-V", "--unknown"]) {
      await assert.rejects(importTicketDirectory(db, root, name, root, "en"), (err: unknown) => {
        assert.ok(err instanceof DispatchError);
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /reserved by the CLI/);
        return true;
      });
    }
    assert.equal(db.prepare("SELECT count(*) AS n FROM tickets").get()?.n, 0);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const action of ["create", "import"]) {
  test(`ticket ${action}: reserved names exit 2 with localized CLI reservation explanation`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "collisions-create-"));
    try {
      fixture(root);
      for (const lang of ["en", "zh"] as const) {
        for (const name of ["serve", "--unknown"]) {
          const args = action === "create" ? [name, path.join(root, "_shared.md")] : [root, name];
          const result = await runCli(["ticket", action, ...args, "--db", path.join(root, "db")], root, lang);
          assert.equal(result.code, 2, result.stderr);
          assert.match(result.stderr, lang === "en" ? /reserved by the CLI/ : /CLI 保留字/);
          for (const word of [name, "ticket", "serve", "mcp", "-h", "-V", "--*"]) assert.ok(result.stderr.includes(word));
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("CLI named legacy ticket and positional -foo reach the same stored-ticket validation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "collisions-run-"));
  try {
    const dbPath = path.join(root, "db");
    const db = openDb(dbPath);
    try {
      for (const name of ["ticket", "-foo"]) db.prepare("INSERT INTO tickets (name, doc, status, sealed_at, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(name, JSON.stringify({ shared: "intentionally invalid shared body", spokes: [] }), "draft", null, "2026-09-12");
    } finally { db.close(); }
    const common = ["--db", dbPath, "--repo-root", root, "--dry-run"];
    const named = await runCli(["--ticket", "ticket", ...common], root, "en");
    const positional = await runCli(["-foo", ...common], root, "en");
    assert.equal(named.code, 2, named.stderr);
    assert.equal(positional.code, 2, positional.stderr);
    assert.match(named.stderr, /Under review/);
    assert.match(positional.stderr, /Under review/);
    assert.ok(named.stderr.endsWith(positional.stderr), "same validation error after first-run provider seeding");
    assert.equal(existsSync(path.join(root, "daemon.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
