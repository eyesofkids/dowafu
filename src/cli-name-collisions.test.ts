import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { CLI_COMMANDS, CLI_SHORTCUTS, isReservedTicketName } from "./cli-commands.js";
import { parseArgs } from "./cli-args.js";
import { openDb } from "./db.js";
import { runCliJob } from "./daemon.js";
import { claimNextJob, submitJob, approveJob } from "./job.js";
import { createTicket, getTicketDoc } from "./ticket-store.js";
import { DispatchError } from "./types.js";
import { m } from "./messages.js";

const RESERVED = ["ticket", "providers", "token", "key", "result", "approve", "serve", "mcp", "-h", "-V", "--json", "--unknown", "--"];

for (const name of RESERVED) {
  test(`reserved ticket creation rejects ${name} in both languages without inserting`, () => {
    const db = openDb(":memory:");
    try {
      for (const lang of ["en", "zh"] as const) {
        assert.throws(() => createTicket(db, name, "unused", lang), (err: unknown) => {
          assert.ok(err instanceof DispatchError);
          assert.equal(err.exitCode, 2);
          assert.match(err.message, lang === "en" ? /reserved by the CLI/ : /CLI 保留字/);
          for (const word of ["ticket", "serve", "mcp", "-h", "-V", "--*"]) assert.ok(err.message.includes(word));
          return true;
        });
      }
      assert.equal(db.prepare("SELECT count(*) AS n FROM tickets").get()?.n, 0);
    } finally { db.close(); }
  });
}

test("non-reserved -foo remains creatable and runnable", () => {
  const db = openDb(":memory:");
  try {
    createTicket(db, "-foo", "stored body", "en");
    const parsed = parseArgs(["-foo"], "en");
    assert.equal(parsed.mode, "run");
    if (parsed.mode !== "run") assert.fail();
    assert.equal(getTicketDoc(db, parsed.ticketDir, "en").shared, "stored body");
  } finally { db.close(); }
});

test("named ticket equals positional, rejects both orders and duplicates, reports missing value", () => {
  const flags = ["--repo-root", "/tmp/repo", "--db", "/tmp/test.db", "--lang", "zh", "--yes", "--job-id", "job"];
  assert.deepEqual(parseArgs(["--ticket", "sample", ...flags], "en"), parseArgs(["sample", ...flags], "en"));
  for (const args of [["a", "--ticket", "b"], ["--ticket", "a", "b"], ["--ticket", "a", "--ticket", "b"], ["--ticket", "a", "serve"], ["--ticket", "a", "mcp"]]) {
    assert.throws(() => parseArgs(args, "en"), DispatchError);
  }
  assert.throws(() => parseArgs(["--ticket"], "en"), { message: m("en", "missingFlagValue", "ticket", "") });
  for (const lang of ["en", "zh"] as const) assert.match(m(lang, "helpText", "dowafu"), /--ticket <name>/);
});

test("named legacy reserved names are opaque, including help/version and --ticket itself", () => {
  for (const name of [...RESERVED, "--help", "--version", "--ticket"]) {
    const parsed = parseArgs(["--ticket", name, "--repo-root", "/tmp/repo"], "en");
    assert.equal(parsed.mode, "run", name);
    if (parsed.mode !== "run") assert.fail();
    assert.equal(parsed.ticketDir, name);
  }
  assert.deepEqual(parseArgs(["--ticket", "--help", "--help"], "en"), { mode: "help" });
});

// This is a dependency test, not just equality against a second handwritten list.
// Replacing reservedTicketNames() with today's literal list MUST fail this test (mutation 7).
test("reservation follows live dispatch registry changes, not a detached literal list", () => {
  const db = openDb(":memory:");
  try {
    for (const registry of [CLI_COMMANDS, CLI_SHORTCUTS]) {
      for (const key of Object.keys(registry)) {
        const table: Record<string, string> = registry;
        const original = table[key];
        const probe = `future-${key}`;
        try {
          table[key] = probe;
          assert.ok(isReservedTicketName(probe), `reservation detached from dispatch: ${key}`);
          assert.throws(() => createTicket(db, probe, "unused", "en"), DispatchError);
          if (key === "serve" || key === "mcp" || key === "help" || key === "version") {
            assert.equal(parseArgs([probe], "en").mode, key);
          }
        } finally { table[key] = original; }
      }
    }
  } finally { db.close(); }
});

// Read actual dispatch expressions: adding a literal branch or a shortcut without
// reserving it fails. Main's command branches must use the live registry tested above.
test("actual CLI dispatch branches and shortcuts cannot bypass the reservation registry", () => {
  let mainBranches = 0;
  for (const filename of ["cli.ts", "cli-args.ts"]) {
    const source = ts.createSourceFile(filename, readFileSync(new URL(filename, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const check = (value: ts.Expression, main: boolean) => {
      if (main) {
        mainBranches++;
        assert.ok(ts.isPropertyAccessExpression(value) && value.expression.getText(source) === "CLI_COMMANDS", "main dispatch must read CLI_COMMANDS");
      }
      if (ts.isStringLiteral(value)) assert.ok(isReservedTicketName(value.text), `unreserved dispatch literal ${value.text}`);
      else if (ts.isPropertyAccessExpression(value)) {
        const registry = value.expression.getText(source) === "CLI_COMMANDS" ? CLI_COMMANDS : CLI_SHORTCUTS;
        const word = (registry as Record<string, string>)[value.name.text];
        assert.ok(word && isReservedTicketName(word), value.getText(source));
      } else assert.fail(`unrecognized dispatch expression: ${value.getText(source)}`);
    };
    const visit = (node: ts.Node) => {
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
        for (const [a, b] of [[node.left, node.right], [node.right, node.left]]) {
          if (a.getText(source) === "process.argv[2]") check(b, true);
          if (filename === "cli-args.ts" && a.getText(source) === "arg") check(b, false);
        }
      }
      if (filename === "cli-args.ts" && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ["argv", "controlArgs"].includes(node.expression.expression.getText(source)) && node.expression.name.text === "includes") {
        check(node.arguments[0], false);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.ok(mainBranches >= 6, "must inspect the actual main dispatch branches");
});

test("worker named args rescue stored serve job through fake spawn and retain all queue options", async () => {
  const db = openDb(":memory:");
  try {
    // Simulate a ticket created before name validation existed; never relax createTicket.
    db.prepare("INSERT INTO tickets (name, doc, status, sealed_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("serve", JSON.stringify({ shared: "legacy marker", spokes: [] }), "sealed", "2026-09-12T00:00:00.000Z", "2026-09-12");
    submitJob(db, "serve", "legacy-job", "zh");
    approveJob(db, "legacy-job");
    const job = claimNextJob(db);
    assert.ok(job);
    const events = new EventEmitter();
    const child = Object.assign(events, { stderr: new EventEmitter() }) as unknown as ChildProcess;
    let captured: string[] = [];
    const outcome = runCliJob(job, "/tmp/isolated.db", "en", {
      spawn: ((_executable: string, args: string[]) => { captured = args; return child; }) as typeof spawn,
      stderr: { write: () => true },
    });
    events.emit("exit", 0, null);
    assert.deepEqual(await outcome, {});
    const entry = captured.findIndex((arg) => /cli\.(ts|js)$/.test(arg));
    assert.ok(entry >= 0);
    const parsed = parseArgs(captured.slice(entry + 1), "en");
    assert.equal(parsed.mode, "run", "legacy serve ticket must run, never start daemon");
    if (parsed.mode !== "run") assert.fail();
    assert.equal(getTicketDoc(db, parsed.ticketDir, "en").shared, "legacy marker");
    assert.equal(parsed.options.yes, true);
    assert.equal(parsed.options.jobId, job.id);
    assert.equal(parsed.options.dbPath, "/tmp/isolated.db");
    assert.equal(parsed.options.langRaw, "zh");
  } finally { db.close(); }
});
