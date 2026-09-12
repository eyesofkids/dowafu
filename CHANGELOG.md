# Changelog

Notable changes per released version. Entries for 0.5.0–0.6.0 were **reconstructed** from
release commits and internal records after the fact; from 0.7.0 on they are written at
release time. Versions before 0.5.0 are not covered here — see the git tags (`v0.3.0`
onwards).

## 0.7.0 — 2026-09-12

### Added

- **`--ticket <name>`** names the ticket explicitly. The positional form still works, and
  giving both is rejected rather than silently resolved. The queue worker now uses the
  flag, which is what makes the fix below reachable for tickets that already exist.
- **Three models**, each verified against the live API before shipping — tool calling,
  usage on every round, and the model name echoed back unchanged:
  `gpt-6-astra`, `deepseek-flash`, `gemini-3.8-flash`.
- `dowafu result --help` and `dowafu approve --help` now print their usage. Previously
  they treated `--help` as an id to look up, failed with "no results found", and opened
  the database on the way.

### Changed

- **`ticket create` and `ticket import` reject names the CLI reserves**: the eight
  subcommands (`ticket`, `providers`, `token`, `key`, `result`, `approve`, `serve`,
  `mcp`), `-h`, `-V`, and any name beginning with `--`. Such a ticket could be created
  before but could never run, because the CLI parsed the name as a command — one named
  `serve` started a daemon instead. Tickets already stored under a reserved name still
  run via `--ticket <name>`.
- **The deepseek model enabled on a fresh install is now `deepseek-flash`.** DeepSeek
  retired `deepseek-v4-flash` on 2026-09-10 and currently routes it to V4.1 Flash with no
  stated end date; shipping it as the default meant new installs depended on that routing.
  `deepseek-v4-flash` stays on the whitelist, disabled by default. **Existing databases
  are not touched** — this only affects a database seeded after upgrading.
- Prices for every provider re-checked against the vendor pricing pages on 2026-09-12.

### Fixed

- **A reviewer could not read its own ticket when the CLI ran with `--repo-root` from a
  different working directory.** The ticket paths in its first message came out absolute
  while the snapshot is keyed by a relative path, so every read of the ticket was refused
  — and the audit still reported success. The result was a paid review written without
  ever seeing the plan. Present since 0.5.0.

### Upgrading

Upgrading the package does not refresh the model list: seeding happens only when the model
table is empty, so your existing prices and enabled flags are never silently rewritten. To
pick up the three new models:

```bash
dowafu providers import "$(npm root -g)/dowafu/providers.json"
dowafu providers list
```

## 0.6.0 — 2026-09-10

*Reconstructed.*

- A daemon no longer runs jobs that were approved before it started; those are returned to
  pending approval at startup, so a restart cannot silently execute an old approval.
- `--doctor` reports the job queue.
- `engines` corrected to `>=22.13.0`.

## 0.5.1 — 2026-09-09

*Reconstructed.*

- Reviewer output no longer carries template placeholders through to the saved report.
- Queued jobs choose their own language: `dispatch_submit` accepts `lang`.

## 0.5.0 — 2026-09-06

*Reconstructed. The largest release so far; this is a summary, not a full list.*

- **Tickets and reviewer output moved into SQLite.** No ticket directories or output files
  on disk. What a reviewer reads is the snapshot taken when the ticket was written, not
  the file as it stands at run time.
- **Job queue and a long-running daemon** (`dowafu serve`), with MCP over stdio
  (`dowafu mcp`) and over HTTP bound to `127.0.0.1` only. Inbound tokens are stored
  hashed, compared in constant time, and rate limited per token.
- **The model whitelist, per-model enabled flags and prices moved into the database**;
  the `--providers` flag was removed. An empty database is seeded from the file shipped
  with the package.
- **API keys come from the database only** (`dowafu key`); environment variables and
  `.env` support were removed, along with the `dotenv` dependency.
- **Costs are stated in dollars** before you approve: a hard upper bound, plus the typical
  spend of past runs when there are any.
