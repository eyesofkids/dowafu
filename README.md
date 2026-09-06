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
> One flag decides the language for the whole run: `--lang en` or `--lang zh-tw`. Without
> it, `DISPATCH_LANG` applies; without that either, the default is **English**. The flag
> wins over the environment variable, and an unrecognized value in either is rejected
> rather than guessed at.
>
> The language reaches everything: the reviewer's prompt and report template, the audit
> that checks the report against it, and the CLI's own output — `--help`, error messages,
> the dry-run report, and the run summary stored with the results. The dry run prints the resolved language per reviewer,
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

Then write a ticket (below) and dry-run it — `dowafu <ticket-dir> --dry-run` is still free. The first thing that costs money is `--yes`.

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
dowafu <ticket-dir> --dry-run   # parse, validate, estimate. No API call, no cost.
dowafu <ticket-dir> --yes       # run it. This is what costs money.
dowafu --help                   # every flag
```

Without `--yes`, the command asks for confirmation. When stdin is not a TTY — which is
the case whenever an agent runs it for you — there is nobody to answer, so it stops
before calling anything.

## The ticket

A ticket is a directory with three kinds of file. The headings are **literal markers the
parser matches** — use one of the two sets below, exactly as written.

| English | 中文 |
| --- | --- |
| `# Questions` | `# 具體問題` |
| `# Allowed reads` | `# 允許讀取` |
| `# Under review` | `# 待審段落` |
| `# Premises` | `# 前提（不受審）` |

| File | Contents |
| --- | --- |
| `_dispatch.md` | which reviewers to run, and with which provider and model |
| `_shared.md` | the premises, and the section under review, pasted in verbatim |
| `<agent>.md` | one per reviewer: its questions, and the files it may read |

```markdown
<!-- _dispatch.md -->
<!-- format: v1 -->
# dispatch auth-review

| agent | provider | model | effort |
| --- | --- | --- | --- |
| hole-finder-safety | deepseek | deepseek-v4-flash | |
| hole-finder-feasibility | openai | gpt-5.6-luna | |
```

```markdown
<!-- hole-finder-safety.md -->
# Questions
1. Does the permission check described here hold under concurrent requests?

# Allowed reads
- lib/auth-guard.ts
- prisma/schema.prisma
```

Either set is accepted, and the choice does **not** decide the reviewer's language —
that comes from `--lang` / `DISPATCH_LANG` (see above). The two sets are aliases for the
same fields, so an English ticket can run in Chinese and vice versa. Mixing both sets
inside one reviewer's file is not supported — the first heading that matches wins.

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

| provider | model |
| --- | --- |
| `openai` | `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol` |
| `deepseek` | `deepseek-v4-flash` |
| `gemini` | `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`, `gemini-3.6-flash` |
| `anthropic` | `claude-opus-5`, `claude-sonnet-5` |

The list ships with the package as `providers.json`. Point `--providers` at your own copy
to use anything else.

## Driving it from an agent

`publish/` contains the skills and reviewer definitions to copy into a project, so that
an agent working there knows how to write a ticket, what to check before spending, and
how to read the results. Copy both directories — `.claude/` holds the reviewer
definitions the CLI itself reads, so it is required no matter which agent you use.

It ships in both languages, `publish/en/` and `publish/zh-tw/`. **Pick one.** A mix does
not work: a reviewer's fixed closing line has to match the template the audit checks it
against.

```bash
npx degit eyesofkids/dowafu/publish/en#v0.5.0 .claude-pack   # or publish/zh-tw

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

## License

MIT
