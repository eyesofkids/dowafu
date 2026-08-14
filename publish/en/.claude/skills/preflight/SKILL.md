---
name: preflight
description: Before starting work in a project, check whether its environment has silently disabled the workflow: whether the workflow-specification chapter is actually readable, whether the skills and lenses are present, whether tmp/ is gitignored. Claude Code additionally checks auto-compact and the subagent model; other hosts additionally check whether dowafu runs. Read-only, report-only — changes no settings.
---

# preflight — environment pre-check

**Run this before using this workflow in a project for the first time.** Dispatching, implementing, and wrapping up only to discover afterwards that the environment had silently disabled the workflow means the whole stretch of work was wasted.

Assume the project in front of you has **never seen any of this**: nothing may be installed, half of it may be installed, or every file may be present while you still cannot read them. Those three states must be told apart, and **none of them raises an error**.

> **Read-only, report-only — do not modify any settings file.** Those belong to the user, several of them are global, and touching one affects all of their projects. Produce the list and let them decide whether, and what, to change.

**This document has three sections. Everyone must check section 1; sections 2 and 3 are either/or:**

| If you are | Check |
| --- | --- |
| Any agent | Section 1 |
| **Claude Code** | Section 1 + **section 2** |
| **Any other host** | Section 1 + **section 3** (the items in section 2 do not exist for you; checking them yields nothing but "not found") |

> **The criterion is "who is running you", not "which model is behind you".** When Claude Code is pointed at a compatible API or another vendor's model via BYOK in `settings.json`, it **is still Claude Code** — `autoCompactEnabled` and `CLAUDE_CODE_SUBAGENT_MODEL` still apply, so use section 2. Conversely, another host running Claude as its model still uses section 3.
>
> **When in doubt, check both**, and honestly mark anything you could not determine as "not found".

---

## 1. Everyone must check these, whatever the environment

Run the commands from the repository root. **There is no guarantee where your working directory is — `cd` there first.**

```bash
cd <absolute path to the repo root>

echo "=== workflow specification ==="
ls CLAUDE.md AGENTS.md workflow_spec.md 2>&1
# This only locates which file holds the content. A hit here ≠ you can read it — see the criterion below.
# Both spellings: a project may carry this chapter in another language than the pack you installed.
grep -nE "Plan → Implement → Accept|規劃→實作→驗收" CLAUDE.md AGENTS.md workflow_spec.md 2>/dev/null

echo "=== skills and lenses ==="
ls .claude/skills/ 2>/dev/null
ls .claude/agents/hole-finder*.md 2>/dev/null

echo "=== tmp/ ==="
git check-ignore -q tmp && echo "ignored" || echo "not ignored"
```

### Is the workflow specification readable

**There is only one criterion: can you, right now, read the contents of the chapter "Plan → Implement → Accept (hub-and-spoke form)"?**

**The chapter may be there under the other language's heading.** Language packs install their own copy, so a project that already had this chapter can end up with two — in two languages, only one of which auto-loads. The grep above looks for both spellings for exactly this reason; if it returns hits in more than one file, read the next paragraph before deciding anything.

If you can read it, it passes. Whether the content is pasted directly into the entry file or pulled in via something like `@` is **the user's choice and outside the scope of this check**.

If you cannot read it, mark it as failing, then **go find it yourself** (usually `workflow_spec.md` at the repo root), and note in your report that "the specification is not in the auto-loaded set; it was read manually this time" — so the user knows a different session will miss it again.

**If you find more than one copy, say which one auto-loads.** A project may already carry this chapter inline in its entry file while a second copy sits at the repo root as `workflow_spec.md` — and the two may be in different languages, since each language pack installs its own. "The content is readable" is then not enough: report **which copy is in your context**, and that nothing keeps the two in step. The one that auto-loads is the one that governs every later session.

> **Why might it be unreadable?** The entry file differs by host: Claude Code reads `CLAUDE.md` (**not `AGENTS.md`**), while most other hosts read `AGENTS.md` at the repo root. And `@xxx.md` is Claude Code's import syntax — **other hosts do not expand it**, so what you see is a single line of text and the specification never entered your context at all. That does not mean the project is misconfigured; it is a difference on your side.

### Skills and lenses

Whether `.claude/skills/find-holes-external/` and the lens definitions are present. **Report the filenames you actually saw, and name any that are missing** — "I saw three of them" is not a check; which three is the check.

Four files are expected, and all four are normal:

| File | What it is |
| --- | --- |
| `hole-finder.md` | The general-purpose lens |
| `hole-finder-cost.md` | Cost |
| `hole-finder-feasibility.md` | Feasibility |
| `hole-finder-safety.md` | Security, concurrency, failure states |

> The glob above has no hyphen before the `*` on purpose: `hole-finder-*.md` cannot match `hole-finder.md`, so counting from it while expecting four never adds up.

**If a lens is missing, do not write a replacement yourself** — it is the source of the spoke's system prompt, and a self-written version puts the output out of step with the audit criteria.

### `tmp/`

If it is not gitignored, mark it as failing: spoke reports contain the verbatim text of the plan and would be committed into version control. **Do not edit `.gitignore` yourself** — ask the user.

---

## 2. If you are a Claude Code agent

**If you are going to dispatch externally (`/find-holes-external`), items one and four of §3 apply to you too** — the CLI has to be runnable and configured no matter which host is driving it. The rest of §3 is about hosts other than this one.

The two items below affect **only Claude Code's own in-process sub-agents**. For external dispatch (`find-holes-external` via `dowafu`), the spoke's model is decided by the ticket's `_dispatch.md` and is **unaffected by either of them** — if this project only uses external dispatch, checking this section changes nothing.

```bash
cd <absolute path to the repo root>

echo "=== settings (lowest to highest precedence) ==="
for f in ~/.claude/settings.json .claude/settings.json .claude/settings.local.json; do
  [ -f "$f" ] && { echo "--- $f"; cat "$f"; }
done

echo "=== environment variables ==="
echo "DISABLE_AUTO_COMPACT=${DISABLE_AUTO_COMPACT:-(unset)}"
echo "CLAUDE_CODE_SUBAGENT_MODEL=${CLAUDE_CODE_SUBAGENT_MODEL:-(unset)}"

echo "=== models declared in agent definitions ==="
grep -H "^model:" .claude/agents/*.md 2>/dev/null || echo "(no agent definitions, or none specify a model)"

echo "=== main model and effort ==="
grep -h "\"model\"\|\"effortLevel\"" ~/.claude/settings.json .claude/settings.json .claude/settings.local.json 2>/dev/null || echo "(unset, using defaults)"
```

### auto-compact

**`autoCompactEnabled` not appearing at any settings layer = failing**, because its default is `true`. Do not read "I did not see the setting" as "there is no problem" — that makes this check pass forever.

The workflow specification requires handing off via `/wrap` and restarting the session when context runs short, rather than compacting (compaction is lossy, and once compacted a hot session has no value left).

Related: `autoCompactWindow` (100000–1000000) and the environment variable `DISABLE_AUTO_COMPACT`.

### The subagent model

`settings.json` has **no** "default subagent model" key — but **one environment variable overrides everything**. Resolution runs through four layers, highest to lowest; **lay all of them out for the user**:

1. **The `CLAUDE_CODE_SUBAGENT_MODEL` environment variable** (when set to an alias or a model ID)
2. The `model` parameter passed on each call
3. The `model:` frontmatter in `.claude/agents/*.md` (or `~/.claude/agents/`)
4. The main conversation's model (which is also the default when the frontmatter omits it)

**Layer 1 overrides the `model:` in every agent definition file**, including the ones deliberately set to opus — that is the "set it once and every in-process dispatch turns into a lightweight model" case. And it is **global: setting it in project A affects project B**.

The `availableModels` allowlist then filters the three layers above: a blocked family alias is swapped for the newest permitted version of that family, and in every other case it **falls back to inheriting the main conversation's model**. So `model: opus` in the frontmatter **does not guarantee opus runs**.

**Checking only one of those layers and reporting "all fine" misses the most common case.**

**The consequences of a downgrade are silent**: every in-process sub-agent becomes a lightweight model, hole-finding still runs, still produces output, still wraps up — the quality simply drops, and nothing anywhere flags it.

---

## 3. If you are not a Claude Code agent

The two items in section 2 do not exist for you; skip them. What you need to confirm is the four things below, **in this order** — if an earlier one does not hold, checking the later ones is pointless.

### One: where `dowafu` is, and whether it runs

**This is the precondition.** If the tool will not start, no ticket however well written can be dispatched; discovering it at dispatch time wastes a whole round of ticket assembly.

```bash
dowafu --version
```

Printing a version number passes. Failing to print one means exactly one of two things:

| Symptom | What it means | How to report it |
| --- | --- | --- |
| `Operation not permitted` | **The sandbox is blocking it**, not a missing install. The CLI usually lives under the home directory, and sandboxes do not read the home directory by default | Retry after allowing it per your host's prompt. Also tell the user that the API key (`~/.config/dowafu/.env`) and outbound network are blocked the same way and will need allowing at dispatch time |
| `command not found` | It may not be installed, or it may be installed outside PATH | Ask the user where the CLI is installed (have them run `which dowafu`); **do not go searching the filesystem yourself** |

**`command -v dowafu` finding nothing does not mean it is not installed** — do not use that as the criterion.

**A command that neither returns nor errors is a third case: it is waiting.** Without `--yes` the CLI prints a confirmation prompt and blocks on stdin; depending on the host that surfaces as a timeout, as silence, or as an offer to send input on your behalf. Note which one your environment does — you will meet it again at dispatch time, and that is a much worse moment to find out.

### Two: whether the lens definitions and skills are present

See "skills and lenses" in section 1. One point matters especially for you:

**The lens definitions are for the CLI to read, not for you.** They are the source `dowafu` uses to assemble the spoke's system prompt; you only need to confirm the **files exist**, not understand their contents. The skills are what you read.

### Three: the workflow specification's content, somewhere you can read it

See "is the workflow specification readable" in section 1; the criterion is the same: **can you, right now, read the contents of that chapter.**

**You are more likely than Claude Code to trip on this one**, so it is worth a second look. `@xxx.md` is Claude Code's import syntax and you will not expand it — if the entry file contains only that line, what you see is one line of text, and **you may well believe you have already read the specification**. Actually check whether that chapter's content is in your context; do not go by impression.

### Four: is the CLI configured — `dowafu --doctor`

```bash
dowafu --doctor
```

It prints where the config directory resolved to, whether `.env` is there, **which providers have a key** (presence only — it never prints a value), the bundled model whitelist, and which lens definitions it found. It calls no API and costs nothing, and it needs no ticket, which is what makes it usable before anything else exists.

Report the missing rows as they are printed. **Do not offer to write the key for the user, and do not ask them to paste one into this conversation** — whatever is pasted here stays in this conversation's history. Creating the directory and an empty template is fine; the value itself is theirs to type into the file.

A `dowafu --doctor` that prints nothing but an error is the same finding as item one: the CLI is not runnable from here, and nothing below it matters yet.

---

## 4. Output

One table, one page at most:

| Item | Status | Current state | How to fix |
| --- | :-: | --- | --- |
| Workflow specification | ✗ | The "Plan → Implement → Accept" chapter is not in my context; I have read `workflow_spec.md` manually to cover it | To have it auto-load every session, the entry file's wiring needs adjusting |
| `tmp/` | ✓ | Ignored by `.gitignore` | — |

**State at the top of the table which kind of host you are and whether you followed section 2 or section 3**, so the user does not assume the unchecked items were checked.

**Mark "not found" separately from "passes".** When a file cannot be read, or an item cannot be determined, say so honestly rather than counting it as a pass — the reason this skill exists is to catch silent failures, and silently failing yourself defeats the purpose.
