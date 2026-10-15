# Changelog

Notable changes per released version. Entries for 0.5.0–0.6.0 were **reconstructed** from
release commits and internal records after the fact; from 0.7.0 on they are written at
release time. Versions before 0.5.0 are not covered here — see the git tags (`v0.3.0`
onwards).

## 0.9.0 — 2026-10-16

### Added

- **Eight models**, each verified against the live API before shipping — tool calling, usage
  on every round, and the reasoning parameters dowafu sends:
  `gpt-6-luna`, `gpt-6-sol`, `gpt-6.1-sol`, `claude-haiku-5-5`, `claude-sonnet-5-5`,
  `claude-opus-5-5`, `claude-fable-5-1`, `gemini-4-argon`.
- The `find-holes-external` skill (both language packs) gains a section on what to do when the
  model a dispatch needs is disabled: models are turned on only through
  `dowafu providers enable`, only after the user agrees, and a spoke on a model that is
  disabled by default names that model when its hard cap is put to the user.

### Removed

- **`gemini-3.7-flash` and `deepseek-v4-flash`.** Both were retired upstream and their
  requests are now served by a different model (`gemini-3.8-flash` and DeepSeek-V4.1-Flash),
  so a report labelled with either name was not produced by that model, and its cost was
  estimated at the wrong price. From now on, a model that upstream has retired or redirected
  is removed; one that is only marked deprecated stays until its retirement date.
- **`claude-haiku-4-5-20251001`.** See Fixed.

### Changed

- **Enabled on a fresh install: one model per provider — the cheapest tier of the newest
  generation.** That is now `gpt-6-luna`, `deepseek-flash`, `gemini-3.5-flash-lite` and
  `claude-haiku-5-5`. `gpt-5.6-luna` and `gemini-3.1-flash-lite` are still on the whitelist,
  disabled by default.
- Prices for every provider re-checked against the vendor pricing pages on 2026-10-16.
  Where a vendor charges more than one rate, the list keeps the higher one so that estimates
  err high: `claude-haiku-5-5` uses its rate for prompts over 100K tokens, and
  `gemini-4-argon` its rate from 2026-12-01 (it is half that until 2026-11-30).
- The skill examples now use models that are enabled on a fresh install.

### Fixed

- **`claude-haiku-4-5-20251001` could never dispatch**, although it was one of the models
  enabled on a fresh install. It rejects both the `effort` parameter and adaptive thinking,
  and dowafu sends both on every Anthropic request. It is removed rather than special-cased;
  `claude-haiku-5-5` takes its place.

### Upgrading

- `dowafu providers import --bundled` adds the new models. As before, it applies the shipped
  defaults only to models you don't have yet, so **`gpt-6-luna` and `claude-haiku-5-5` are
  enabled**, and every model already in your database keeps its enabled flag — including
  `gpt-5.6-luna` and `gemini-3.1-flash-lite` if you had them on.
- 🔴 **Importing does not remove the three dropped models.** Run
  `dowafu providers disable <model>` for each of `gemini-3.7-flash`, `deepseek-v4-flash` and
  `claude-haiku-4-5-20251001` that you still have. A ticket that names one of them should be
  switched to a listed model.

## 0.8.0 — 2026-09-13

### Added

- **Tickets now have two states: draft and sealed.** `dowafu ticket seal <ticket-id>
  --repo-root <dir>` freezes a ticket, including each reviewer's lens definition as it stands
  at that moment. Sealing needs at least one spoke and every lens file to exist; if anything
  is missing, nothing is sealed. A sealed ticket cannot be edited and cannot be unsealed —
  `dowafu ticket copy <sealed-ticket> <new-id>` gives you a new draft instead.
- **`dowafu providers import --bundled`** imports the model list shipped with the package
  without needing its path, and always applies the shipped defaults to models you don't have
  yet.
- `--doctor` prints where the shipped `providers.json` is; `--doctor --json` gains a
  `bundledProvidersPath` field. No existing field changed.

### Changed

- **A draft cannot be run or queued.** Running one exits with code 5 before any spend;
  `dispatch_submit` refuses it without creating a job; `dispatch_approve` and
  `dowafu approve` refuse a job whose ticket is a draft. Dry runs work in both states.
- `dispatch_tickets` shows each ticket's state as a fixed English `[draft]` or `[sealed]`,
  and a draft's line carries the exact command to seal it.
- `ticket show` prints the state on its first line; `--json` output gains `ticketStatus`.

### Fixed

- **A queued job used the lens definitions of whatever directory the daemon was started
  from.** The worker never received a repository root, so a daemon started in one project
  silently ran another project's ticket with its own same-named lenses. A sealed ticket now
  carries its lenses and never reads `.claude/agents/` at run time.
- **A ticket could still be changed after its job was approved**, so the worker could run
  content — and a cost — that nobody had approved. Sealed content is frozen.

### Upgrading

- 🔴 **Every existing ticket becomes a draft.** The database is migrated on first use (schema
  version 5 → 6). Seal a ticket again before dispatching it. A job already in the queue cannot
  be approved while its ticket is a draft.
- To pick up the model list shipped with a release, run `dowafu providers import --bundled`.
  Upgrading still never rewrites your prices or enabled flags on its own.

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

- **The install command printed inside each language pack's own README pointed at the
  `v0.4.0` tag** — unchanged through four releases, so anyone following it fetched
  reviewer definitions three versions old. All four places that carry the tag are now on
  the released version.
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
