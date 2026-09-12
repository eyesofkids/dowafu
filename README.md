# dowafu

**English** ｜ [繁體中文](https://github.com/eyesofkids/dowafu/blob/main/README_zh-tw.md)

A read-only review harness: it sends a section of a document to external models, decides
what each of them may read, records what they did, and audits the shape of what they
returned.

You write a ticket. `dowafu` calls each provider's API. Each reviewer — a *spoke* —
reads only the files you whitelisted, and returns observations with the evidence it
read them from. Everything it did is recorded for you to check.

**Spokes produce observations, not verdicts.** What to do about them stays with you.

> ### English and Traditional Chinese are both fully supported.
>
> Two settings decide the language, and they cover different things.
>
> `--lang en` / `--lang zh-tw` sets the language of **a dispatch**: the reviewer's prompt
> and report template, the audit that checks the report against it, the dry-run report,
> and the run summary stored with the results.
>
> `DISPATCH_LANG` sets the language of **the CLI's own interface** — `--help`, `--doctor`,
> parse errors, and the subcommands (`key`, `providers`, `token`, `approve`, `serve`).
> **`--lang` does not reach these.** They are printed before that flag has been validated,
> and `--doctor` in particular may be the very tool you reach for when the language
> settings are themselves what is broken.
>
> Without either, the default is **English**, and an unrecognized value in either is
> rejected rather than guessed at. The dry run prints the resolved language per reviewer,
> so you can see it before anything is sent.
>
> A ticket's section headings may be written in either language regardless — they are
> field names, not a language switch. See [Ticket format](#ticket-format).
>
> The skills and reviewer definitions come in both languages too, under `publish/en/` and
> `publish/zh-tw/`. **Install one or the other, never a mix** — a reviewer's closing line
> has to match the template the audit checks it against.

## Install

```bash
npm install -g dowafu
```

The command is `dowafu`.

## First run

Five steps, in this order. The first three cost nothing.

1. **Install the CLI** — see above. `dowafu --version` should print a version number.
2. **Copy one language pack into your project** — the commands are under "Driving it from an agent" below. Pick `publish/en/` or `publish/zh-tw/`; never mix the two.
3. **Ask your agent to run `preflight`** — "run the preflight skill". It reports whether the wiring took, whether the lens definitions are where the CLI expects them, and whether `tmp/` is ignored by git. It reads and reports; it changes nothing.
4. **Put your keys in place** — run `dowafu key` and paste each one you need. Only the providers you actually dispatch to need a key. **Do not paste a key into the agent conversation**: it stays in that conversation's history. Type it into `dowafu key` in your own terminal.
5. **Check the setup** — `dowafu --doctor`. It prints where the config directory and the database resolved to, which providers have a key (presence only, never the value), the model whitelist and which models are enabled, and the lens definitions it found. No API call, no cost, and no ticket required.

Then write a ticket (below) and dry-run it — `dowafu <ticket-id> --dry-run` is still free. The first thing that costs money is `--yes`.

## API keys

Keys live in the database. Set them from your own terminal:

```bash
dowafu key
```

It lists the providers, takes the key you paste without echoing it, stores it, prints back
only the last four characters, and offers to verify it against the provider right away.
`dowafu key list` shows which providers have one — presence only, never the value —
`dowafu key rm <provider>` removes one, and `dowafu key test <provider>` verifies one
against the real API (that call costs money, and it asks first). `dowafu key` needs an
interactive terminal: with stdin piped it refuses rather than reading the pipe.

Only the providers you actually dispatch to need a key.

**This version reads no `.env` file and no `*_API_KEY` environment variable.** There is one
source, so there is no precedence to work out and nothing left in your environment that can
quietly win over the key you just set. Coming from 0.4.x: delete `~/.config/dowafu/.env`
and set the keys again with `dowafu key`.

The database is `$DISPATCH_HOME/dowafu.db`, which defaults to `~/.config/dowafu/dowafu.db`
(`DISPATCH_HOME` or `XDG_CONFIG_HOME` override it). **The keys are stored in it as plain
text** — like the file before it, it is protected by nothing but its permissions.

## Usage

```bash
dowafu <ticket-id> --dry-run   # parse, validate, estimate. No API call, no cost.
dowafu <ticket-id> --yes       # run it. This is what costs money.
dowafu --help                  # every flag
```

Without `--yes`, the command asks for confirmation. When stdin is not a TTY — which is
the case whenever an agent runs it for you — there is nobody to answer, so it stops
before calling anything.

## The ticket

A ticket lives in the database, not on disk. Build one with the CLI:

```bash
dowafu ticket create <ticket-id> <shared-file>
dowafu ticket add-spoke <ticket-id> <agent> <provider> <model> <body-file> [effort]
dowafu ticket add-allow <ticket-id> <agent> <repo-relative-path> --repo-root .
```

The body argument of `create` and `add-spoke` takes a path — or `-`, which reads it from
stdin, so a heredoc writes the whole thing without staging a file first:

```bash
dowafu ticket create auth-review - <<'EOF'
# Premises
- none

# Under review
...
EOF

dowafu ticket add-spoke auth-review hole-finder-safety deepseek deepseek-flash - <<'EOF'
# Questions
1. Does the permission check described here hold under concurrent requests?

# Allowed reads
- lib/auth-guard.ts
- prisma/schema.prisma
EOF
```

`add-allow` validates the path immediately, refuses `_docs/`, and stores the file's
content as it stands at that moment — dispatch never re-reads it, so what a reviewer sees
is that snapshot. `dowafu ticket show <ticket-id>` prints the models, the allowlists and
the estimates.

### Section headings

The headings inside the bodies above are **literal markers the parser matches** — use one
of the two sets below, exactly as written.

| English | 中文 |
| --- | --- |
| `# Questions` | `# 具體問題` |
| `# Allowed reads` | `# 允許讀取` |
| `# Under review` | `# 待審段落` |
| `# Premises` | `# 前提（不受審）` |

Either set is accepted, and the choice does **not** decide the reviewer's language —
that comes from `--lang` / `DISPATCH_LANG` (see above). The two sets are aliases for the
same fields, so an English ticket can run in Chinese and vice versa. Mixing both sets
inside one reviewer's body is not supported — the first heading that matches wins.

### Importing an older ticket directory

Before 0.5.0 a ticket was a directory of three files — `_dispatch.md`, `_shared.md`, and
one `<agent>.md` per reviewer. That form still loads, as a one-off migration:

```bash
dowafu ticket import <dir> [ticket-id] --repo-root .
```

Reviewer definitions live in `.claude/agents/<agent>.md` under the repo root — they are
the source of each spoke's system prompt, and the CLI reads them directly. Results are not written to
disk. They go into the SQLite database (`$DISPATCH_HOME/dowafu.db` by default), which holds
each spoke's report, the audit table with the actual cost, and the exact request and
response for every call. Read a run back with `dowafu result <id>`.

## What the tool guarantees

- **Reads are whitelisted per call.** A spoke asking for a file outside its list is
  refused, and the refusal is recorded.
- **`_docs/` is off limits**, whatever the whitelist says.
- **Nothing is billed before you confirm.** The dry run prints the resolved repo root,
  each reviewer's model and language, token estimates and the hard-cap dollar amount, and calls no API.
- **Secrets are masked** in everything stored in the database and in stdout.
- **Failures stop the run.** A missing key, an unknown model, a file that does not
  exist — each aborts with the path or name that caused it, before any spend.

## Models

| provider | model | on a fresh install |
| --- | --- | :-: |
| `openai` | `gpt-5.6-luna` | **enabled** |
| | `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-6-astra` | disabled |
| `deepseek` | `deepseek-flash` | **enabled** |
| | `deepseek-v4-flash`, `deepseek-v4-pro` | disabled |
| `gemini` | `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite` | **enabled** |
| | `gemini-3.6-flash`, `gemini-3.7-flash`, `gemini-3.8-flash` | disabled |
| `anthropic` | `claude-haiku-4-5-20251001` | **enabled** |
| | `claude-opus-5`, `claude-sonnet-5` | disabled |

Fifteen models, five of them enabled out of the box — the pricier ones start disabled so
that a typo cannot quietly dispatch to an expensive model. Dispatching to a disabled model
is rejected before any spend, and tells you the `providers enable` command to run.

`deepseek-v4-flash` was retired upstream on 2026-09-10 and is currently routed to V4.1
Flash with no stated end date. It stays on the list so existing tickets keep working;
**new tickets should use `deepseek-flash`**.

The list ships with the package as `providers.json` and is seeded into the database the
first time one is opened. From then on **the database is the source of truth**:

```bash
dowafu providers list                      # the whitelist, and which models are enabled
dowafu providers enable|disable <model>    # flip one on or off
dowafu providers import <path>             # load your own file
```

**Upgrading the package does not refresh the list.** Seeding happens only when the model
table is completely empty, so an upgrade never silently changes a price or an enabled flag
you already have. To pick up models added in a later release, import the shipped file
yourself:

```bash
dowafu providers import "$(npm root -g)/dowafu/providers.json"
dowafu providers list                      # confirm the new models are there
```

There is no `--providers` flag — it was removed in 0.5.0, when the whitelist moved into
the database. Passing it is rejected as an unknown option.

## Driving it from an agent

`publish/` contains the skills and reviewer definitions to copy into a project, so that
an agent working there knows how to write a ticket, what to check before spending, and
how to read the results. Copy both directories — `.claude/` holds the reviewer
definitions the CLI itself reads, so it is required no matter which agent you use.

It ships in both languages, `publish/en/` and `publish/zh-tw/`. **Pick one.** A mix does
not work: a reviewer's fixed closing line has to match the template the audit checks it
against.

```bash
npx degit eyesofkids/dowafu/publish/en#v0.7.0 .claude-pack   # or publish/zh-tw

cd .claude-pack
TARGET=<your project>
mkdir -p "$TARGET/.claude/skills" "$TARGET/.claude/agents" "$TARGET/.agents/skills"
cp -R .claude/skills/. "$TARGET/.claude/skills/"
cp -R .agents/skills/. "$TARGET/.agents/skills/"
cp .claude/agents/*.md "$TARGET/.claude/agents/"
cp workflow_spec.md "$TARGET/"
```

Once fetched, run `dowafu --doctor` to confirm it recognizes all the lenses.

Once the files are in place, have the agent run `preflight` before anything else — it is the check that tells you whether the copy actually took effect in this project's setup.

See `publish/en/README.md` — or `publish/zh-tw/README.md` — for the details, each written
in its own language.

## Running it as an MCP server

An agent can drive `dowafu` over MCP instead of through the shell. Five tools are
exposed: `dispatch_tickets`, `dispatch_submit`, `dispatch_status`, `dispatch_result`
and `dispatch_approve`.

There are two transports, and the difference that matters is who starts what.

| | stdio | HTTP |
| --- | --- | --- |
| Command | `dowafu mcp` | `dowafu serve` |
| Who starts it | the client spawns it | you, in your own terminal |
| Token | none, and none needed | required (`x-api-key`) |
| Runs the reviewers | **no** | yes |

### Both transports need `dowafu serve`

`dowafu mcp` only answers tool calls — **it never runs a reviewer**. The worker that
actually spends money lives in `dowafu serve`. Without one running, an approved job never
runs — `dispatch_submit`, `dispatch_approve` and `dispatch_status` each print a `⚠` line
saying so.

```
stdio:  your client ──spawn──→ dowafu mcp ──┐
                                            ├─ the same SQLite database
        your terminal ────────→ dowafu serve ┘  (the worker is here)

HTTP:   your client ──x-api-key──→ dowafu serve  (endpoint and worker, one process)
```

So on stdio you keep `dowafu serve` running in a terminal next to the client. **Start it
before you approve.** A daemon only runs approvals made while it is up: when it starts,
and again when it stops, any job still waiting in `approved` goes back to pending approval,
so an approval given before the daemon was running has to be given again. `dowafu serve`
prints how many it sent back.

### stdio

Point the client at the command. For Claude Code:

```bash
claude mcp add dowafu -- dowafu mcp
```

No token is involved: the client spawns the process itself, the trust boundary is the
operating system, and there is no network in between to intercept.

### HTTP

`dowafu serve` binds `127.0.0.1:7391/mcp` — **loopback only; there is no `--host` flag.**
Exposing it is a tunnel's job, not the server's. `--http-port <port>` or the
`DOWAFU_HTTP_PORT` environment variable changes the port.

Every request needs a token:

```bash
dowafu token issue --label laptop   # the plaintext prints once and is never stored
```

The database keeps only a SHA-256 hash of it, compared in constant time. Put the
plaintext into your client's MCP configuration as the `x-api-key` header.
`dowafu token list` shows which tokens exist (never their value) and
`dowafu token revoke <id>` kills one. Rate limiting is **per token, not per IP** —
behind a tunnel every request arrives from the same source address.

> **Start the daemon before the client.** If the client starts first it marks the server
> as failed and that entire conversation has no tools — a symptom indistinguishable from
> a misconfigured entry.

### Keeping the daemon running

Nothing wakes `dowafu serve` on demand: a client connects to a socket that is already
listening, so with no process listening there is nothing to wake. Let the OS keep it up
instead.

**macOS** — `~/Library/LaunchAgents/dowafu.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dowafu</string>
  <key>ProgramArguments</key>
  <array>
    <string>/absolute/path/to/dowafu</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/dowafu.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/dowafu.err</string>
</dict>
</plist>
```

Load it with `launchctl load -w ~/Library/LaunchAgents/dowafu.plist`.

**Linux** — `~/.config/systemd/user/dowafu.service`:

```ini
[Unit]
Description=dowafu dispatch daemon

[Service]
ExecStart=/absolute/path/to/dowafu serve
Restart=always

[Install]
WantedBy=default.target
```

Enable it with `systemctl --user enable --now dowafu`.

Three things that bite:

- **Use an absolute path.** Neither launchd nor systemd sees your shell's `PATH`. Run
  `which dowafu` and paste exactly what it prints.
- **Environment variables are not inherited either.** If your shell sets `DISPATCH_HOME`
  or `XDG_CONFIG_HOME`, the daemon will not see them and will resolve a *different*
  database — one with none of your keys or tickets in it. Declare them in the unit.
- **Send the output somewhere.** As a background service there is no terminal left to
  watch, and that is where a port already in use, or a reviewer that died, gets
  explained. Point stdout and stderr at files you can actually find.

With the daemon always up the stdio path needs nothing extra — `dowafu mcp` finds a
worker already running. Typing `dowafu serve` yourself will then refuse with
`daemon already running (pid N)`: that is the guard working, not a fault.

### Stopping and restarting

`dowafu serve --stop` stops the daemon; `dowafu serve --restart` stops it and starts a new
one (or just starts one if none is running). When something would be affected, both ask
first — separately — about:

- **jobs still running** — stopping the daemon does not stop a reviewer already in flight.
  It runs to completion, and its results and API cost are still recorded.
- **jobs approved but not yet started** — they go back to pending approval, so the next
  daemon cannot run them without a fresh approval.

With no terminal to answer (an agent calling it, a script), a question counts as "no" and
nothing is stopped; pass `--yes` to go ahead.

If the daemon ignores SIGTERM, `--stop` says so and prints the pid to inspect. Do not reach
for SIGKILL: a reviewer's worker process can outlive the daemon and still write its results.
And if the daemon comes straight back after stopping, a service manager (the `KeepAlive` /
`Restart=always` above) is restarting it — stop it with `launchctl` or `systemctl` instead.

### Approval is still a separate step

`dispatch_submit` queues a job and stops; nothing is billed until it is approved. Two
ways to approve: `dowafu approve <id>` in your own terminal, or the `dispatch_approve`
tool — which requires the job's hard-cap dollar amount to match what the database
computes, so an agent cannot approve a job whose cost it never showed you.

## License

MIT
