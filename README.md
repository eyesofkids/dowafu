# dowafu

**English** ｜ [繁體中文](https://github.com/eyesofkids/dowafu/blob/main/README_zh-tw.md)

A read-only review harness: it sends a section of a document to external models, decides
what each of them may read, records what they did, and audits the shape of what they
returned.

You write a ticket. `dowafu` calls each provider's API. Each reviewer — a *spoke* —
reads only the files you whitelisted, and returns observations with the evidence it
read them from. Everything lands on disk for you to check.

**Spokes produce observations, not verdicts.** What to do about them stays with you.

> ### Tickets work in English or Chinese. The CLI's own output is Chinese.
>
> Write the ticket's section headings in either language and the rest follows: the
> reviewer is prompted in that language, asked for its report in that language's
> template, and the audit checks it against the matching one. The language is decided by
> the headings themselves — there is no flag to forget — and the dry run prints which one
> it resolved to, per reviewer.
>
> What is still Traditional Chinese: `--help`, error messages, the dry-run report and
> `summary.md`. That is the development language and it has not been translated.

## Install

```bash
npm install -g dowafu
```

The command is `dowafu`.

## API keys

Keys are read from `$DISPATCH_HOME/.env`, which defaults to `~/.config/dispatch/.env`
(`DISPATCH_HOME` or `XDG_CONFIG_HOME` override it). Variables already present in the
environment win over the file, so CI and one-off overrides need no file at all.

```bash
mkdir -p ~/.config/dispatch
cat > ~/.config/dispatch/.env <<'EOF'
DEEPSEEK_API_KEY=
GEMINI_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
EOF
chmod 600 ~/.config/dispatch/.env
```

Only the providers you actually dispatch to need a key. The file is plain text — it is
protected by nothing but its file permissions.

**The current directory's `.env` is never read.** That is where you ran the command, and
usually the project under review; its secrets have no business in a process that is
talking to external APIs.

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

The set you use decides the reviewer's language: `# Questions` gets an English prompt and
an English report template, `# 具體問題` gets the Chinese ones. Mixing the two sets inside
one reviewer's file is not supported — the first heading that matches wins.

Reviewer definitions live in `.claude/agents/<agent>.md` under the repo root — they are
the source of each spoke's system prompt, and the CLI reads them directly. Results are
written to `tmp/spoke/<ticket-id>/`: each spoke's report, a `summary.md` with the audit
table and estimated cost, `run.jsonl` with one line per event, and `raw/` with the exact
requests and responses.

## What the tool guarantees

- **Reads are whitelisted per call.** A spoke asking for a file outside its list is
  refused, and the refusal is recorded.
- **`_docs/` is off limits**, whatever the whitelist says.
- **Nothing is billed before you confirm.** The dry run prints the resolved repo root,
  each reviewer's model and language, token estimates and the output path, and calls no API.
- **Secrets are masked** in `run.jsonl`, `raw/*.json` and stdout.
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

```bash
TARGET=<your project>
mkdir -p "$TARGET/.claude/skills" "$TARGET/.claude/agents" "$TARGET/.agents/skills"
cp -R publish/.claude/skills/. "$TARGET/.claude/skills/"
cp -R publish/.agents/skills/. "$TARGET/.agents/skills/"
cp publish/.claude/agents/*.md "$TARGET/.claude/agents/"
cp publish/workflow_spec.md "$TARGET/"
```

See `publish/README.md` for the details. Those documents are currently written in
Traditional Chinese.

## License

MIT
