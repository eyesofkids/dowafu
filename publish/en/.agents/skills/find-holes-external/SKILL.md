---
name: find-holes-external
description: Dispatch sections of a plan document to external models (OpenAI / DeepSeek / Gemini / Anthropic) for hole-finding review, executed through the local dowafu CLI, where spokes are read-only and governed by an allowlist. Use when you need a heterogeneous perspective, or when the plan has to be reviewed against the real source code. Usage: /find-holes-external <path to plan> [section or question to focus on]
metadata:
  derived-from: ".claude/skills/find-holes-external/SKILL.md"
  derived-from-sha256: "cef716ce7aeee504945074795dd37d0a4f85fdbb6f2a15cffb2471dab1a03982"
---

# find-holes-external — external hole-finding

You are the hub. This skill dispatches a specified portion of a plan document to **external models** for hole-finding review.
**Spokes produce observations, not verdicts; whether to adopt them is the user's call.**

The tool is `dowafu` (a local CLI, already installed globally); invoke it with your terminal tool.
**A spoke reads only what you give it** — read-only, and every file read passes an allowlist check.

> **Everything you need is here; do not go hunting through other documents for supplementary instructions.**

---

## 1. Pre-checks

**One: confirm you can read the lens definitions.** Read `.claude/agents/hole-finder-*.md` and report which ones you see and what perspective each takes. Being able to read them is enough to pass.

**If you cannot read them, stop and tell the user — do not go looking elsewhere, and do not write your own.** Those files are the source of the spoke's system prompt: role, prohibitions, output format, and closing line all live there. A self-written version puts the spoke's output out of step with the audit criteria.

**Two: confirm `tmp/` is git-ignored.** A spoke's report contains the verbatim text of the plan and does not belong in version control. If it is not ignored, stop and ask the user whether to add it — **do not edit `.gitignore` yourself**.

---

## 1.5 Four things about execution

**Ticket format, the per-question table, and the discipline for assessing reports have nothing to do with where you run** — those are in the process steps below and apply throughout. This section covers **execution level** only.

**One: every `dowafu` command takes this shape — omit neither the `cd` nor `--repo-root .`:**

```bash
cd <absolute path to the repo root> && dowafu <ticket dir> --repo-root . --dry-run
```

**`--lang` sets the language of the CLI output and of the spoke prompts; it defaults to `en`.** This is the English pack and its lens files are in English, so the default already matches — pass `--lang en` explicitly only if `DISPATCH_LANG` is set to something else in this environment. Precedence is `--lang` > `DISPATCH_LANG` > the built-in `en`. A pack and a run language that disagree raise no error at all; you simply get a report in one language and spoke prompts in the other.

There is no guarantee which workspace folder your terminal lands in, and `--repo-root` defaults to the cwd. A wrong cwd fails **silently** — the ticket still parses, the spokes still go out, only the allowlist boundary and the lens definitions point somewhere else.

**Two: `dowafu` is an external global CLI and is not inside the workspace. Do not go looking for it; just run:**

```bash
dowafu --version
```

Failing to print a version number means exactly one of two things, and **in neither case should you search the filesystem yourself**:

- **`command not found`** — ask the user where the CLI is installed (have them run `which dowafu`), then call it by absolute path
- **`Operation not permitted`** — **the sandbox is blocking it, not a missing install.** It usually lives under the home directory, and sandboxes do not read the home directory by default. Allow it per your host's prompt and try again; the API key and outbound network are blocked the same way, so allowing it is required, not optional

**Three: `--yes` is mandatory.**

Without it, the CLI prints `Continue? [y/N]` and blocks waiting for input, at which point your host hands control back to you and offers a **send input** option — **that path can deliver a `y` and start billing immediately**.

> **Do not take it.** Adding `--yes` means pressing the confirmation on the user's behalf, and you must have their explicit agreement in the conversation before you add it.

**Four: run for real in the background, and track progress through a file rather than terminal output.**

Poll `tmp/spoke/<ticket-id>/run.jsonl` with your file-reading tool: the CLI writes events into that file one by one, so you can see which round it reached and whether there was a `round_error`. **For how to decide it has finished, see §5** — "two `spoke_end` events" is only half of it. Background terminal output is not guaranteed to reach you, and a single spoke can run for several minutes.

> **Treat the terminal as a launcher, not as a data channel.**

> This section names tools by function ("terminal tool", "file-reading tool") because tool names vary by version and model — a mismatch is normal; use whichever one you actually have.

---

## 2. Present the dispatch plan and wait for the user's confirmation (**no dispatching before it**)

| What to list | Notes |
| --- | --- |
| The passage under review | Which section of which file, how many lines |
| How many spokes, and which lenses | See below |
| Each spoke's provider / model | See below |
| **The per-question "question → which file holds the answer → is it on the list?" mapping** | **Mandatory; format below** |
| Estimated cost magnitude | For reference: three spokes on a medium ticket run about 40k tokens |
| **Where each spoke's artifacts land** | **Mandatory**, see "One spoke, one landing spot" below |

### Questions and the allowlist **must be listed against each other, question by question**

Do not list "questions" and "allowlist" as two separate blocks — that makes it impossible to see which question has no file behind it. Use this format:

| Q | Question | Which file holds the answer | On the list? |
| --- | --- | --- | --- |
| 1 | Is the schema change in §3.1 feasible | `prisma/schema.prisma` | ✅ |
| 2 | Does §2's description of the current state match the actual code | `lib/a.ts`, `lib/b.ts` | ❌ **must be added** |

**This is the most common mistake**: asking a question without providing the file needed to answer it — asking "is this the only entry point" without providing that file itself, or asking "does the description of the current state match" while providing only "the file where the new claim lives". All the spoke can do is note what is missing in its "cannot verify" section, and **that is the dispatcher's failure, not its own**.

Listing it per question lets the user see at a glance what is missing. **That column is not a formality; it is currently the only thing in this skill standing between you and a missing file** — `--dry-run` can check the format, but it cannot check whether the questions and the list line up.

**Any change the user makes to the count, the models, the lenses, or the questions is followed without argument.**

**When deciding the allowlist, ask yourself question by question: "where is the answer to this one? is that file on the list?"** Matching files to the lens's name (giving the safety lens the security-related files) produces the wrong list — the lens is **the angle you look from**, the list is **the material you look at**. When the list contains only the **producing** side of some behavior while the question asks about the **displaying** side, the spoke is physically incapable of answering correctly; swap in a set of files aimed at where the answers live and the same lens finds it. **The point of this self-check is to catch the gap before dispatching, not after.**

### One table per spoke — and the table is the deliverable, not a claim about one

**Fill in that table once per spoke, and put both tables in front of the user.** Saying the lists were checked, or that they cover what is needed, does not replace showing them: "the allowlist covers every question" is a sentence, and a sentence costs nothing to write whether or not it is true.

Each row needs **the path you actually expect the answer in** — not a directory, not "the tags routes", not the lens's name. Write it the way it appears in the allowlist so the two can be read against each other:

| Q | Question | Which file holds the answer | On the list? |
| --- | --- | --- | --- |
| 1 | Does `requireAuth` return the userId the delete-self check needs | `lib/auth-guard.ts` | ✅ |
| 2 | Is the last-admin guard atomic | `prisma/schema.prisma` (the passage itself is the rest) | ✅ |

**Before writing a path into that column, confirm the answer is in that file.** Grep for the symbol, or open it. The column exists to catch a missing file before dispatch; filled in from memory it catches nothing — a plausible-looking filename passes the format check exactly as well as the right one does, and the spoke pays for the difference.

**Two spokes may end up with the same files, but say why.** An identical list is a result you can explain, not a starting point — and a list you trimmed until the two differed is the same mistake wearing the opposite mask.

**One list shared by two lenses converges on the intersection, not the union.** What drops out first is whatever only one lens needed, which is precisely what that lens was dispatched to look at; the spoke can then only record the gap in its "cannot verify" section, and finding out that way costs a full dispatch. Trimming for cost is legitimate — trim each spoke's list against its own questions, never against the other spoke's.

### One spoke, one landing spot — dig the holes before you dispatch

A spoke's artifacts land in `tmp/spoke/<ticket-id>/` under the group of files named after its agent: `<agent>.md` plus `raw/<agent>.request.json` / `.response.json` / `.errors.json`. That group moves together, so the landing spot is the pair `<ticket-id>` + `<agent>`.

**List the landing spot for every spoke in the dispatch plan. The criterion is one line: as many landing spots as spokes, all distinct.**

| Spoke | Lens | Provider / model | Artifacts land in |
| --- | --- | --- | --- |
| 1 | safety | openai / gpt-5.6-luna | `tmp/spoke/auth-review-luna/hole-finder-safety.md` |
| 2 | safety | deepseek / deepseek-v4-flash | `tmp/spoke/auth-review-ds/hole-finder-safety.md` |
| 3 | feasibility | gemini / gemini-3.6-flash | `tmp/spoke/auth-review-luna/hole-finder-feasibility.md` |

**Two spokes resolving to the same path means you are one hole short** — and the fix is not a different filename, it is a separate ticket directory: one model per directory, suffix the ticket-id, dispatch each once. Different lenses can share a directory; their agent names already differ.

Count that column, do not eyeball it. **You do not need to know what a collision does** — if the count is off, stop and split the directories.

### Lenses

| agent | Perspective |
| --- | --- |
| `hole-finder-safety` | Security, concurrency races, failure states |
| `hole-finder-cost` | Cost gates, ordering of billable calls, resource-consumption ceilings |
| `hole-finder-feasibility` | Feasibility, implementability, gaps between spec and implementation |

Dispatching one is fine; dispatching all three is fine. **Do not rule a lens out up front because "it doesn't seem to apply"** — the cost lens will still find things like "an unauthenticated endpoint with no ceiling on resource consumption" in a project that makes no billable calls at all.

### Models (only these; anything else is rejected)

| provider | model |
| --- | --- |
| `openai` | `gpt-5.6-luna` / `gpt-5.6-terra` / `gpt-5.6-sol` |
| `deepseek` | `deepseek-v4-flash` / `deepseek-v4-pro` |
| `gemini` | `gemini-3.1-flash-lite` / `gemini-3.5-flash-lite` / `gemini-3.6-flash` |
| `anthropic` | `claude-opus-5` / `claude-sonnet-5` |

### When the user has not specified models

**Propose a set and explain what you based it on** (cost magnitude, size of the material, whether this lens needs deep reasoning), then **wait for confirmation**. Do not decide and dispatch on your own; and once they have changed it, do not switch back because "the other one seems better".

How to trade models off is the user's project decision, and this document does not make it for them.

---

## 3. Writing the ticket

Write into `tmp/dispatch/<ticket-id>/`, using a topic slug as `<ticket-id>` (for example `auth-review`).

### `_dispatch.md`

```markdown
<!-- format: v1 -->
# dispatch <ticket-id>

| agent | provider | model | effort |
| --- | --- | --- | --- |
| hole-finder-safety | openai | gpt-5.6-luna | |
| hole-finder-cost | deepseek | deepseek-v4-flash | |
| hole-finder-feasibility | gemini | gemini-3.1-flash-lite | |
```

The first line `<!-- format: v1 -->` is **required**; `model` is required; list only the spokes you are dispatching. `effort` may be left blank, meaning **`high`** — all four providers currently default `reasoning.default` to `high`. To change it, check `providers.json`'s `reasoning.allowed`: **each provider's range differs** (for example `deepseek` has no `medium`); a value outside that range is rejected with the list of allowed values shown, never silently downgraded.

**No agent may appear twice in the same `_dispatch.md`.** One row per agent; to run one lens across several models, split it into separate ticket directories (see "One spoke, one landing spot" in §2). **The CLI rejects a duplicate agent at parse time, so the dry run stops as well** — that is the last line of defence, not a reason to skip counting landing spots.

### `_shared.md` (shared by every spoke)

```markdown
# Premises
- <a one-line conclusion, e.g. "stateless JWT authentication, already settled">
- <write "none" if there are none>

# Under review
<paste the plan's passage verbatim — do not summarize, do not rewrite>
```

**The passage under review must be embedded verbatim**; you cannot write "see section 3 of `_docs/xxx.md`" — spokes cannot read `_docs/` (it is a forbidden directory and the allowlist will reject it).

### `<agent>.md` (one per spoke; the filename must match the agent column in `_dispatch.md`)

```markdown
# Questions
1. <question>
2. <question>

# Allowed reads
- src/foo.ts
- lib/bar.ts
```

**Four rules**:

1. **Do not write role definitions** ("you are a…", "you must not…", "please close with…"). Role, prohibitions, output format, and closing line are read by `dowafu` from `.claude/agents/<agent>.md` and assembled into the system prompt. Putting them in the ticket creates two sources for the same rules — the same rule appearing twice, worded differently.

2. **Keep questions open; do not point at what you have already found.** Write the answer into the question and the spoke finding it is just the ticket read back to you.

3. **The allowlist must cover the files actually needed to answer those questions.** Ask yourself per question: which files do I have to read to answer this? If one is missing, all the spoke can do is note what it lacked in its "cannot verify" section — **that is the dispatcher's failure, not its own**. Paths are **relative to the repo root**. An empty list is legal (a pure text review), but then it cannot read code and you lose the most valuable class of finding: "the document says X, but `src/foo.ts:42` actually does Y". **The list belongs to this `<agent>.md`, not to the dispatch** — do not copy another spoke's list over wholesale: a file that spoke needs and this one does not is dead weight in the read order, and the reverse is a hole. **A file you did not open is not evidence that the answer is elsewhere** — if you cannot point to the file that answers a question, the question has no file behind it yet, whatever the table says.

4. **Put the large files last — this alone can halve the cost.** Spokes read files in **strict list order**, most models **call for one file per round**, and every round resends everything read so far. So the number of times a file is billed again = **total rounds − the round it was read in** — **the earlier it sits, the more times it is resent**. For a file of a dozen-odd k tokens, first versus last can nearly double that spoke's total. The method is simple: **sort ascending by file size**, largest last. If you are unsure of the size, `wc -l` first. **This still applies when you shuffle the list order** — pin the large files at the end and shuffle only the rest.

### How to run it 2–3 times

One dispatch is one sample. **Run the same configuration 2–3 times and take the union.**

- Suffix the ticket-id (`<topic>-r1` / `-r2` / `-r3`), **one separate directory per run**
- **Use a byte-identical ticket for the second run**, changing only the ticket-id
- **Compare the first two results before deciding how to run the third**:
  - Clearly new items appeared → for this model a plain rerun is productive; run the third one verbatim as well
  - Nearly the same set → this model converges on an identical prompt, and **without perturbation you will get nothing new**. Make the third run **reorder the allowlist**, leaving the questions and `_shared.md` untouched word for word

When reordering, **the large files still stay pinned at the end** (rule 4 above); shuffle only the rest.

---

## 4. Dry run first (costs nothing)

**This is the only checkpoint before money is spent.** Once a ticket really goes out, billing starts, and a failure or interruption partway through does not get the money back — **there is no resume; rerunning means paying again**. A failed dry run costs nothing to fix and repeat. **So this step cannot be skipped.**

What it catches: `repoRoot` pointing at the wrong project, a wrong model name, missing lens definitions, files on the allowlist that do not exist, `tmp/` not being ignored, an estimate over the gate's ceiling — all of it stopped before any API is actually called.

> You already confirmed the lens definitions and `tmp/` in section 1. This is not asking you to redo it; it is telling you that **even if section 1 was skipped, this gate still catches them** — but not the other way round, so section 1 still has to be done.

**What it cannot catch is the ticket's content**: whether the questions are good, and whether the allowlist lines up with them, are both invisible to a dry run. That is what you were supposed to finish in section 2 (the per-question table), and the dry run will not do it for you.

```bash
dowafu tmp/dispatch/<ticket-id> --repo-root . --dry-run
```

**One dry run covers one ticket directory.** If this batch was split across several directories — which it is whenever one lens runs across several models — **dry-run each of them**, and add the estimates together before putting any number in front of the user. Dry-running the first one and going straight to the real run leaves every other directory unchecked.

**Explain what this step is for before you run it.** The user has probably never used this tool, and seeing you issue a command will make them think dispatching — and billing — has already started:

> This step only parses the ticket, validates the configuration, and estimates usage. **It calls no API and incurs no cost.** Its purpose is to confirm that what is about to go out is correct, before any money is spent.

**Relay the report to them once it finishes**; do not just say "the dry run passed". At minimum these items:

| Report item | What the user needs to understand |
| --- | --- |
| `repoRoot` | Whether it points at their project |
| `model` / `effort` | Which model each spoke will actually use |
| Initial prompt estimate | How much gets sent at the very start |
| Allowlist estimate + file count | What the spoke can read, and how much of it |
| Worst-case total | **This is a ceiling, not an expectation** (the sum of each spoke's cap); the actual figure is usually far below it |

**Relay it in your own words, in a table — and never inside a code fence unless you are pasting the output byte for byte.** A fenced block means "this is what the tool printed"; putting a rewritten version inside one claims an accuracy you did not deliver. Rewriting is fine, and often reads better than the raw output. Passing a rewrite off as the raw output is not.

**Whatever you relay, the qualifiers come with it.** The report's hedges are what stop the numbers being misread: that a total is a ceiling rather than an expectation, which day the price list was drawn from, what assumptions an estimate rests on, the lines confirming each lens's closing line. They are the first things to look droppable and the only things that make the numbers safe to act on. **Drop a qualifier and you have handed the user a firmer number than the tool gave you.**

**Lines the tool marks with `⚠` or `ℹ` are relayed word for word, never paraphrased.** A `⚠` line is the tool telling you something is wrong right now — that the output directory already holds artifacts, that the list order is costing you money, that a spoke read nothing. Rewriting one into a calmer sentence is the single most expensive thing you can do to this report, because the reader loses the only signal that asked for a decision. In particular: `⚠ Sorting large files last could bring this down to N` means **your order is not sorted**; it does not mean "already sorted, reordering would save a little".

The qualifiers that must survive, by name:

| Where | What must come with the number |
| --- | --- |
| Each spoke's line | `effort=`, `lang=`, `store=`, and its `cap` |
| Price sub-line | the per-M figures **and** `priced as of <date>` |
| `ℹ` closing-line checks | one line per spoke, as printed |
| Initial prompt estimate | that it excludes the ticket and the allowlist, and the gate's cap |
| Allowlist estimate | that it is an upper bound, **not deduplicated**, and the chars-per-token basis |
| Read-order amplification | that it is an upper bound assuming sequential reads and does not apply to batching providers; the ordering verdict; and that the figure excludes the initial prompt and ticket |
| Worst-case total | that it is a **ceiling, not an expectation**, and that it is the sum of the per-spoke caps |

Numbers without these read as firmer than the tool meant them. If you convert tokens to money yourself, say that the conversion is yours and which price line you used.

The report gives tokens, not money, and that **only holds for the dry run**. To convert to money, **the price list is `providers.json`'s `pricing`** (`inputPerM` / `cachedInputPerM` / `outputPerM`) — **do not look it up on the vendor's website**: those numbers are exactly what the CLI bills against, and pulling from the website would make "what you reported" and "what the CLI actually charges" disagree. If `pricingSource.asOf` looks stale, report it to the user rather than editing the number yourself (fix `providers.json` instead). **For the real run**, `summary.md` has an "estimated cost" column, and each spoke also prints a `cost=` line when it finishes — that figure is already computed by the CLI, so **just relay it; do not compute it yourself**.

Then check each item: `repoRoot` is this project, `model` matches what you wrote, **the `effort` printed in the report is the tier you expected**, the token estimate is a sensible magnitude, and **there is no `⚠ Output directory ... is not ignored by the git repo it lives in` warning**.

If any item is wrong, fix the ticket and rerun — **do not proceed**.

---

## 5. The real run

**The output directory must be one that does not exist yet.** Check `tmp/spoke/<ticket-id>/`: if something is already there, **pick a new ticket-id and dispatch under that** — a fresh id costs nothing and removes the collision entirely.

**Deleting artifacts is the user's call, never yours.** Not before dispatching, not to tidy up, not because the directory is in the way. You may ask whether to clear it; you may not clear it yourself, and you may not run over it. What sits there was paid for, and nothing in the directory tells you whether the user still needs it. (Section 7's cleanup is a different thing: that happens *after* they have ruled, because they said so.)

**The CLI enforces this.** If the directory is not empty it stops before dispatching — nothing called, nothing spent — and tells you to pick a different ticket-id. **There is no flag that overrides it**: clearing the directory is the user's action, not a switch you can pass.

The CLI clears `run.jsonl` when it starts (stale events would make you miscount), **but that step only happens if it actually starts**. If startup fails, the previous run's artifacts sit there untouched — and **the files will not tell you whether they belong to this run**.

```bash
dowafu tmp/dispatch/<ticket-id> --repo-root . --yes
```

> **This step costs money.** `--yes` means pressing the confirmation on the user's behalf, and **you must have their explicit agreement in the conversation before adding it**.
>
> What happens without `--yes` depends on your host — see §1.5. Neither case costs anything.

> **A single spoke can run for ten minutes, and the speed cannot be predicted in advance** — same material, same ticket, comparable token magnitude, and two runs can still differ several-fold. That is the other side's server load: not attributable, not predictable.
>
> **`--timeout` is the timeout for one API call, not for how long a spoke runs** — a spoke makes many rounds of calls, and it does not bound the total; do not use it to estimate the whole run.
>
> **Foreground execution has its own external tool timeout** (on the order of ten minutes), unrelated to `--timeout`, and `--timeout` cannot prevent it. **If you expect a long run (large list, many questions, a slower model), switch to background execution** rather than waiting it out in the foreground.

### Startup confirmation: confirm it really started before you begin waiting

**Note the current time before issuing the command** (`date -u +%Y-%m-%dT%H:%M:%SZ`), then read `tmp/spoke/<ticket-id>/run.jsonl` a dozen-odd seconds after:

| What you read | Verdict |
| --- | --- |
| The file does not exist | **It did not start** — the CLI creates it the moment it runs; this is not "still waiting on the API" |
| A `spoke_start` whose `ts` is later than when you issued the command | It started; begin polling |
| Content whose `ts` is earlier than when you issued the command | **It did not start, and what you are reading is the previous run's artifact** |

`ts` is the ISO 8601 timestamp present on every line, and **it is the only mechanical basis for deciding whether this artifact belongs to this run**.

**If it did not start, do not keep waiting.** This failure mode is invisible from the inside: the previous artifact's two `spoke_end` events both say `succeeded`, the format, the audit columns, and the cost all look normal, and the timestamp is the only tell.

### How long is too long

**What matters is not total elapsed time but whether `run.jsonl` is still growing.** Ten minutes for a single spoke is normal, but **within any ten minutes there will be a new event written** — the default timeout for a single API call is ten minutes, and both a timeout and a retry write their own `round_error` line.

> **If more than ten minutes pass with no new events, stop and tell the user**; do not keep waiting and do not rerun on your own. Report the last event together with its `ts` and let them decide.

**Progress is judged from `run.jsonl` alone** — the CLI writes events into it one at a time, so even after a Ctrl-C you can see how far it got. Whether the terminal channel is reliable depends on your host (see §1.5); `run.jsonl` is unaffected.

**Deciding it has finished requires two things at once**: two `spoke_end` events, **and** that this `run.jsonl` passed the startup confirmation above. Looking only at `spoke_end` treats the previous run's artifact as this run's result.

**If you really hit a failure or timeout: whether to rerun is the user's decision — do not rerun on your own.** A rerun means paying again, and the money already spent before the interruption is unrecoverable (there is no resume). Report the state at the point of interruption (how far `run.jsonl` got, the failure message) and let them judge. This does not conflict with "rerun the whole thing on zero reads": that rule is about "it did not run", this one is about "it ran and was interrupted" — different cost structures.

---

## 6. Collection — summary by default, verbatim the exception

The artifacts are in `tmp/spoke/<ticket-id>/`: `<agent>.md` (the report), `summary.md` (the audit table), `run.jsonl` (the execution log), and `raw/` (complete requests and responses).

**`run.jsonl` is appended event by event and is never overwritten.** If the artifacts and `raw/` were clobbered — by a rerun, or by another spoke writing to the same name — that file still holds each spoke's `spoke_start` (provider and model), per-round usage, every read attempt including the refused ones, any errors, and the `spoke_end` token and cost figures. The report text is gone; what was spent and what was read can still be reconstructed.

> **Confirm §5's startup check passed before collecting.** No file in this directory will tell you whether it belongs to this run.

**The order of presentation must not be changed**:

1. **The user must see each spoke's content**, labeled with lens and model. **Synthesis is the default**, satisfying four required conditions:
   1. **Declare the trade-off explicitly** — state at the top of the section that "this is a summary, not verbatim"; never summarize silently
   2. **The reading must cover every item, skipping none** — every observation from every spoke has to appear in the "hub reading" below, which is what replaces verbatim reproduction as the source of auditability: an original not laid out in front of the user does not mean it went unread
   3. **Point to the original's path** (`tmp/spoke/<ticket-id>/<agent>.md`) so the user can compare at any time
   4. **This only holds while the artifacts still exist** — once section 7 has cleared them there is no original to check against
   > What this rule guards against is not "no original exists", it is **the hub cherry-picking what suits it**. Satisfy those four and a summary guards against it just as well; what has to be preserved is the purpose, not the "verbatim" mechanism itself.

   **Reproduce it verbatim in two situations**: the artifacts have already been cleared by section 7 (there is no original left to check, so a summary cannot satisfy condition 4), or a single report is short enough that summarizing would be overkill. Everything else defaults to a summary.

   **If you cannot meet condition 2, dispatch fewer spokes rather than falling back to verbatim** — the problem is dispatch scale, not presentation; do not treat "not confident" as a reason to revert to full reproduction.
2. **Relay `summary.md`'s audit cell into that same section by naming every segment it contains.** One line per segment per spoke, **in the order `summary.md` prints them** — `Tool calls:` comes first, ahead of `Closing line:`. Where a segment is empty the CLI prints its own word for that (`none`); **copy what it printed, and never leave a segment out**. Writing them all out costs you nothing over writing out most of them, and a missing name is something the user can see — a missing row is not.

   **A segment beginning with `⚠` is never dropped, and neither is `(audit unavailable)`.** Those are not decoration sitting outside the named columns; they are the audit telling you something went wrong, and dropping them leaves the user holding only the parts that said nothing did.

   **Any segment carrying content is reproduced word for word.** Only `pass` and the CLI's own empty-value word may be compressed. The segments saying "nothing here" are the cheap ones to keep, and the one saying something is the one worth dropping — so this rule is deliberately asymmetric: **the more a segment has to say, the less freedom you have with it.**
3. **Then open a separate "hub assessment" section** — deduplicate, and annotate each item with your preliminary judgment (holds / does not hold + why / needs the user's ruling). **Every item carries the observations it came from**, by spoke and number (`safety 2, 3; feasibility 9`), and **every observation appears against at least one item**. Two spokes' worth of numbered observations either all show up in that column or the ones that did not are visible at a glance — which is the point: without the numbers, an observation that quietly failed to make it into the assessment cannot be told apart from one you judged and dismissed.

### Merging multiple runs

**Take the union, not the intersection.** Mark the occurrence count per item (`3/5` style), but **do not use occurrence count as importance** — something seen once may be severe, and something seen every time may be a false positive. **Importance is always judged by the hub after opening the file, never by vote count.**

### Three things you must verify when assessing a report

**One: `toolCalls[]` in `run.jsonl`.** That is what it actually read, not what it says it read. A spoke with zero tool calls produced a text-only review, and its claims about the code should be discounted.

**Two: any claim about safety or correctness — open the file and verify it yourself before passing it on.** Do not report a spoke's claim to the user as a conclusion.

**Line numbers must be re-verified.** A spoke's citations can be off by anywhere from a few to dozens of lines while **the description of the content is usually right** — usable at the fact level, unusable at the location level. **A wrong location is not a hallucination** (a hallucination is "that passage does not exist in that file at all"), and the two are handled differently: a hallucination calls for a rerun or a different model, a wrong location only needs you to locate it again. **Mistaking a wrong location for a hallucination throws away an entire usable output.**

**This applies to the line numbers you write, too.** Re-verifying a spoke's citation and then citing it from memory a few paragraphs later puts the drift back in under your own name — and yours carries more weight with the user, because you said you opened the file.

**Three: when verifying a spoke's citation, a comment is not evidence.** "The spoke says a comment backs this conclusion" is not enough — you also have to verify **whether what the comment says still holds**. Comments drift away from the code, and a drifted comment reads exactly like a correct one, so verifying only that "the comment exists and matches" turns a wrong claim into an accepted one. The first item of the MUST checklist in AGENTS.md, "a filename, a comment, or a line number is not enough", was written for authoring plans; here it extends to accepting a spoke's citations.

**A spoke reporting "I could not read X" is a correct report, not a false alarm.** It names a file you did not put on its list, which makes it your gap and not its mistake — filing it under "false alarm", or quietly resolving it yourself and moving on, hides the one signal that tells you the allowlist was wrong. Resolve it if you can, and still say plainly that the list was short.

### Reading the audit table

| Column | Meaning |
| --- | --- |
| `Tool calls:N (allowed N / rejected N)` | How many reads, how many rejected — the statistics from `toolCalls[]` in `run.jsonl`. **Printed first**, ahead of the closing line |
| `Closing line:` | pass / fail |
| `Observations:N` | The item count; `uncountable` means the format could not be recognized — go read the original |
| `Citations outside allowlist:` | Paths cited from outside the allowlist, **possibly guessed at** — judge against `toolCalls[]`. **This column has never once caught a genuine hallucination**: what it catches is usually the spoke copying an abbreviated path out of the material, relaying a path the material mentioned while stating it could not read it, or mixing absolute and relative paths. Check first whether that path appears in your own `_shared.md`, or is merely written differently; do not assume it was invented |
| `Cannot-verify section:` | Whether that section was written per the template. **When judging output quality, look at how specific this section is** (for example, noting per item which conclusion depended on which unreadable file), not at the observation count — counts are unreliable, since overlap and padding both inflate them without indicating quality |
| `Suspect phrases:` | **Suspected only** — keyword matching always produces false positives; read the matched sentence and judge for yourself |

**If the columns are preceded by `⚠ Zero source reads (allowed N file(s))`** — see "what to do on zero reads" below, and handle that before reading any other column.

### What to do on zero reads

When you see `⚠ Zero source reads`:

**First confirm whether the allowlist was empty.** An empty list is a legal configuration (a pure text review), and zero reads is then expected behavior, not an anomaly.

**A non-empty list with zero reads — treat it as "this ticket was not executed".**

> Not "poor quality", not "partially usable": **it did not run**. The ticket's questions were written on the premise that there is code (for example "does the existing code already contain a value-lookup path that could be reused directly"), and when that premise fails the whole set of questions fails with it.

**Handling: rerun the whole thing. Do not analyze the content, and do not go hunting for "the parts that are still useful".**

Analyzing the report after discovering zero reads, trying to salvage something usable, **gets it exactly backwards**. The reason is where the information comes from:

- The spoke received only the ticket, and **you wrote the ticket**
- So the report's content has only two possible sources: **your own writing reflected back**, or **invention**
- There is no third category — it has no channel to any information you do not already have
- **Reading something that "matches what I thought" feels valuable, but that is your own echo**; and the one genuinely "new" part is usually the hallucination (naming a constant as existing in a file that contains no such string, say)

Any salvageable text-level observation **will come back on a rerun, in a better version**. Rerunning is cheap.

**How to rerun**: switch models, or reorder the allowlist and rerun (see "how to run it 2–3 times" in section 3). It happens more easily with a very large list — while rerunning, take the opportunity to trim the list down to the files that can actually answer those questions.

Finally, tell the user what happened.

---

## 7. Cleanup (after the user has ruled)

```bash
rm -rf tmp/spoke/<ticket-id> tmp/dispatch/<ticket-id>
```

**This is the only place in this workflow where you delete anything, and only once the user has ruled and told you to.** Anywhere else — including a directory that is in your way before dispatch — follow §5: you may ask, you may not delete.

Leave the lens definitions; they will be used again.

---

## When something goes wrong

| Symptom | What to do |
| --- | --- |
| The report's numbers look wrong | Stop at `--dry-run` and check `_dispatch.md` |
| Failure partway through | Read the `round_error` events in `run.jsonl` (status code, message, which round) and `raw/<agent>.errors.json`; the content of completed rounds is still written out |
| A genuine failure or timeout | **Ask the user whether to rerun; do not rerun on your own** — a rerun means paying again, and what was spent before the interruption is unrecoverable |
| Hitting 429 | Rerun with `--concurrency 1` |
| Poor report quality | Rerun with a different model, or run the same configuration again and take the union (see "how to run it 2–3 times" in section 3) |
| Missing API key | The user has to set it in `~/.config/dowafu/.env`; **do not touch that file yourself** |
| `dowafu` not found | **Not found does not mean not installed** — see §1.5; usually the sandbox is not reading the home directory |
| `Operation not permitted` | Blocked by your host's sandbox, **not a problem with the ticket or the command**. Allow it per the prompt and run again |

**If you hit any anomaly, tell the user** — do not swallow it or work around it silently.
