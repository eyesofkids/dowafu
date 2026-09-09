---
name: find-holes-external
description: Dispatch sections of a plan document to external models (OpenAI / DeepSeek / Gemini / Anthropic) for hole-finding review, executed through the local dowafu CLI, where spokes are read-only and governed by an allowlist. Use when you need a heterogeneous perspective, or when the plan has to be reviewed against the real source code. Usage: /find-holes-external <path to plan> [section or question to focus on]
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

**Two: `tmp/` no longer needs checking.** This used to require confirming `tmp/` was git-ignored, because a spoke's report landed there and the ticket body had to be staged there before writing it in. **Neither is true anymore**: reports now live only in SQLite (§6) and never touch disk; and writing a ticket no longer needs staging either — `create`/`add-spoke` can read the body straight from stdin (§3).

---

## 1.5 Differences by execution environment (read only the subsection for your host)

**Ticket format, the per-question table, and the discipline for assessing reports have nothing to do with where you run** — those are in the process steps below and apply to every host. This section covers **execution-level** differences only.

> **The criterion is "who is running you", not "which model is behind you".** When Claude Code is pointed at a compatible API or another vendor's model via BYOK in `settings.json`, it **is still Claude Code** — tools, settings, and which entry file it reads are all unchanged, so use the first subsection. Conversely, another host running Claude as its model does not use the first subsection.
>
> **If you are unsure which you are, use the second subsection.** Everything in it applies to Claude Code too; it just takes a few more keystrokes. Going the other way round gets you stuck outright.

### You are a Claude Code agent

Four things; everything else follows the process below:

- **Without `--yes` the CLI aborts immediately and calls no API** (stdin is not a TTY, so nobody can answer the confirmation prompt). That is a mechanical guarantee — but it stops "nobody is present", not "you decided to run it yourself"
- **The terminal streams live output** during the run: per-round tokens and tool calls. That channel is reliable
- `dowafu` is on PATH; issue the command directly
- **To tell whether MCP is available, check whether you hold the `dispatch_*` tools** — do
  **not** go by connection errors in the system prompt; those may refer to a *different*
  server with a similar name. To be sure, actually call `dispatch_tickets` once: if the tool
  is not in your list you cannot invoke it, and claim meets fact immediately

### You are not a Claude Code agent

Four things differ.

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

**Four: whether you can poll progress depends on which path you take — running the CLI directly, the path this section covers, still has no such entry point.**

Progress does have somewhere to be read now (a `progress` table in SQLite, one row per round), but the only entry point that can read it back is the MCP `dispatch_status` tool, and it keys on a job id — that only exists when you go through the MCP queue (`dispatch_submit` → `dispatch_approve` → the daemon runs it). **The path this section describes — running the CLI directly — has no job id, so `dispatch_status` cannot be used**: the per-round output exists only in the terminal running the CLI, which you usually cannot see when running in the background. For the details, and the difference between "finished" and "finished and intact", see §5, "Once it is running".

> **A spoke running silently for several minutes is normal, not a hang.**
> **Do not rerun because it went quiet** — a rerun means paying again, and the money already spent is unrecoverable. For how to decide it has finished, see §5.

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

A spoke's artifacts are the database row keyed by `<ticket-id>` + `<agent>` (report, full request and response, tokens and cost all in the same row, moving together). That pair is the landing spot.

**List the landing spot for every spoke in the dispatch plan. The criterion is one line: as many landing spots as spokes, all distinct.**

| Spoke | Lens | Provider / model | Artifacts land in |
| --- | --- | --- | --- |
| 1 | safety | openai / gpt-5.6-luna | `SQLite results/auth-review-luna/hole-finder-safety.md` |
| 2 | safety | deepseek / deepseek-v4-flash | `SQLite results/auth-review-ds/hole-finder-safety.md` |
| 3 | feasibility | gemini / gemini-3.6-flash | `SQLite results/auth-review-luna/hole-finder-feasibility.md` |

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

Tickets never touch disk — write straight into SQLite through the CLI. The body argument for `create`/`add-spoke` can be a path, or `-` (read the body from stdin, heredoc or pipe both work); the two styles can be mixed:

```bash
dowafu ticket create <ticket-id> <shared-file>
dowafu ticket add-spoke <ticket-id> <agent> <provider> <model> <spoke-body-file> [effort]
dowafu ticket add-allow <ticket-id> <agent> <repo-relative-path> --repo-root .
```

With `-`, a heredoc is the most direct way to feed the whole body in one shot, nothing staged first:

```bash
dowafu ticket create <ticket-id> - <<'EOF'
# Premises
- none

# Under review
...
EOF

dowafu ticket add-spoke <ticket-id> <agent> <provider> <model> - <<'EOF'
# Questions
1. ...

# Allowed reads
- ...
EOF
```

`-` only occupies the body's own positional slot, so `add-spoke`'s `[effort]` still follows it (`- low`) and parses correctly whether given or not. Stdin must be piped or redirected — an interactive terminal gets a clear error, not a hang waiting for input. `add-allow`'s path argument was never a body in the first place, so it is unaffected and still takes a path.

`add-allow` validates the path immediately, rejects `_docs/`, and stores its current content in SQLite; dispatch never re-reads it. Migrate an old directory once with `dowafu ticket import <dir> [ticket-id] --repo-root .`. Use `dowafu ticket show <ticket-id>` to inspect models, allowlists, and estimates.

The ticket goes into the database under `<ticket-id>`, a topic slug (for example `auth-review`) — that id is what you pass later to dispatch, to read the report, and to read the results.

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

What it catches: `repoRoot` pointing at the wrong project, a wrong model name, missing lens definitions, files on the allowlist that do not exist, an estimate over the gate's ceiling — all of it stopped before any API is actually called.

**There is also one thing it warns about but does not block**: when the material under review looks like it was cut off by a `#` heading from an embedded document, the report prints an extra `⚠` line (what it looks like and what to do about it are in the report-item table below). The dry run still passes and no money has been spent yet, but what this guards against is "pay in full, review only half" — the same priority as everything above.

> You already confirmed the lens definitions in section 1. This is not asking you to redo it; it is telling you that **even if section 1 was skipped, this gate still catches it** — but not the other way round, so section 1 still has to be done.

**What it cannot catch is the ticket's content**: whether the questions are good, and whether the allowlist lines up with them, are both invisible to a dry run. That is what you were supposed to finish in section 2 (the per-question table), and the dry run will not do it for you.

```bash
dowafu <ticket-id> --repo-root . --dry-run
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
| `⚠ under-review text may have been cut off` | Demote the embedded document's `#` headings to `##`, or wrap it in a quadruple-backtick fence — a triple-backtick fence cannot contain a document that already carries its own triple-backtick fences. The ticket-writing section already says this; this is the second reminder |

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

The report gives tokens, not money, and that **only holds for the dry run**. To convert to money, **the price list is `providers.json`'s `pricing`** (`inputPerM` / `cachedInputPerM` / `outputPerM`) — **do not look it up on the vendor's website**: those numbers are exactly what the CLI bills against, and pulling from the website would make "what you reported" and "what the CLI actually charges" disagree. If `pricingSource.asOf` looks stale, report it to the user rather than editing the number yourself (fix `providers.json` instead). **For the real run**, the audit table has an "estimated cost" column, and each spoke also prints a `cost=` line when it finishes — that figure is already computed by the CLI, so **just relay it; do not compute it yourself**.

Then check each item: `repoRoot` is this project, `model` matches what you wrote, **the `effort` printed in the report is the tier you expected**, the token estimate is a sensible magnitude, and **there is no `⚠ Output directory ... is not ignored by the git repo it lives in` warning**.

If any item is wrong, fix the ticket and rerun — **do not proceed**.

---

## 5. The real run

**One ticket-id runs once.** Check with `dowafu ticket show <ticket-id>`: if the report ends with a "Completed N times" line, that ticket already has results — **pick a new ticket-id and dispatch under that**. A fresh id costs nothing and removes the collision entirely.

**Deleting artifacts is the user's call, never yours.** Not before dispatching, not to tidy up, not because something is in the way. You may ask whether to clear it; you may not clear it yourself, and you may not run over it. **Those results were paid for**, and the database will not tell you whether the user still needs them.

**The CLI enforces this.** If that ticket-id already has results it stops before dispatching with exit 5 — nothing called, nothing spent — and tells you to pick a different id. **There is no flag that overrides it.**

```bash
dowafu <ticket-id> --repo-root . --yes
```

> **This step costs money.** `--yes` means pressing the confirmation on the user's behalf, and **you must have their explicit agreement in the conversation before adding it**.
>
> What happens without `--yes` depends on your host — see §1.5. Neither case costs anything.

> **When approval goes through an MCP tool, `dispatch_approve` is `--yes`'s counterpart on that path.**
> Before calling it, you must first explain to the user, in the conversation, **the hard-cap dollar
> amount this approval commits to** (already printed in `dispatch_submit`'s summary as "Hard cap $X"),
> and get their explicit agreement — agreement based on "the worst this could cost", not on "whether
> to proceed". This is not "you may not call `dispatch_approve`"; like `--yes`, it is "ask first, then press".

> **A single spoke can run for ten minutes, and the speed cannot be predicted in advance** — same material, same ticket, comparable token magnitude, and two runs can still differ several-fold. That is the other side's server load: not attributable, not predictable.
>
> **`--timeout` is the timeout for one API call, not for how long a spoke runs** — a spoke makes many rounds of calls, and it does not bound the total; do not use it to estimate the whole run.
>
> **Foreground execution has its own external tool timeout** (on the order of ten minutes), unrelated to `--timeout`, and `--timeout` cannot prevent it. **If you expect a long run (large list, many questions, a slower model), switch to background execution** rather than waiting it out in the foreground.

### Once it is running: progress depends on which path you took; "finished" and "finished and intact" are different things

**Going through the MCP queue, you can see progress.** On the path where a ticket is submitted (`dispatch_submit`), approved (`dispatch_approve`, or `--yes` above), and run by the daemon, the job enters `running`, and `dispatch_status` prints each spoke's current round, cumulative in/out tokens, and last-update time — or says plainly "no round has completed yet" when there is none. It watches two different signals:

- **`jobs.heartbeat_at` — is the worker still alive.** The daemon updates it every 2 seconds; once it has gone more than 15 seconds without an update, `dispatch_status` flags it with `⚠` and notes that the next time the daemon runs its reap pass, the job will be marked `interrupted`.
- **Progress — is it moving forward.** That is the per-spoke round and token lines above.

**Stuck retrying a 429** looks like "heartbeat fresh, progress not moving"; **the process actually dying** looks like both stopping.

**Running the CLI directly (not through the queue) has no such entry point.** In the foreground the terminal prints per-round tokens and tool calls as they happen; in the background you cannot see that, and there is no substitute — the job id that `dispatch_status` needs simply does not exist on this path.

> **No feedback is not a hang.** Ten minutes for a single spoke is normal, and the speed cannot be predicted in advance. **Do not rerun because it went quiet** — a rerun means paying again, and the money already spent is unrecoverable.

**Deciding it has finished**: on the direct-CLI path, the CLI returns on its own (with an exit code); on the queue path, `dispatch_status` reports the job as `completed` or `failed`. **The "Completed N times" line at the end of `dowafu ticket show` only counts jobs that went through the queue — a direct run never increments it** — do not use it to detect completion on the direct-run path.

**"Finished" does not mean "finished and intact".** `completed`, and a plain CLI exit, both only mean it did not fail across the board — three out of four spokes can die and it still counts as finished. Once it is done, check these three entry points: `dispatch_status` prints the success/failure split and the names of any failed agents for a `completed` or `failed` job; `dowafu result <ticket-id>` prints an explicit failure marker for a failed spoke (no longer an empty string); and the audit table prints an extra `Provider-reported truncation:<reason>` column when a provider's response looks cut off. **All three work on either path** — `dowafu result` and the audit table accept a ticket-id or a job-id, unlike progress polling, which only exists on the queue path.

> **You no longer have to worry about "is this the previous run's artifact?"** — if that ticket-id already has results the CLI stops with exit 5 before dispatching (§5 above), so there is never a second copy to confuse.

**If you really hit a failure or timeout: whether to rerun is the user's decision — do not rerun on your own.** A rerun means paying again, and the money already spent before the interruption is unrecoverable (there is no resume). Report the last state visible in the terminal and the failure message, and let them judge. This does not conflict with "rerun the whole thing on zero reads": that rule is about "it did not run", this one is about "it ran and was interrupted" — different cost structures.

---

## 6. Collection — summary by default, verbatim the exception

**Read the results back with `dowafu result <ticket-id>`** (before that command existed the only way was to open sqlite3 yourself):

```bash
dowafu result <ticket-id>
```

It prints the audit table (first) and each spoke's report. The complete request, response, tokens and cost sit in the same row for later reconciliation. **Artifacts are never overwritten** — if that ticket-id already has results, the CLI refuses to rerun it (§5).

> **Confirm §5's startup check passed before collecting.** No file in this directory will tell you whether it belongs to this run.

**The order of presentation must not be changed**:

1. **The user must see each spoke's content**, labeled with lens and model. **Synthesis is the default**, satisfying four required conditions:
   1. **Declare the trade-off explicitly** — state at the top of the section that "this is a summary, not verbatim"; never summarize silently
   2. **The reading must cover every item, skipping none** — every observation from every spoke has to appear in the "hub reading" below, which is what replaces verbatim reproduction as the source of auditability: an original not laid out in front of the user does not mean it went unread
   3. **Tell the user how to pull up the original themselves** (`dowafu result <ticket-id>`) so they can compare at any time
   4. **This only holds while the artifacts still exist** — once section 7 has cleared them there is no original to check against
   > What this rule guards against is not "no original exists", it is **the hub cherry-picking what suits it**. Satisfy those four and a summary guards against it just as well; what has to be preserved is the purpose, not the "verbatim" mechanism itself.

   **Reproduce it verbatim in two situations**: the artifacts have already been cleared by section 7 (there is no original left to check, so a summary cannot satisfy condition 4), or a single report is short enough that summarizing would be overkill. Everything else defaults to a summary.

   **If you cannot meet condition 2, dispatch fewer spokes rather than falling back to verbatim** — the problem is dispatch scale, not presentation; do not treat "not confident" as a reason to revert to full reproduction.
2. **Relay the audit table into that same section by naming every segment it contains.** One line per segment per spoke, **in the order the audit table prints them** — `Tool calls:` comes first, ahead of `Closing line:`. Where a segment is empty the CLI prints its own word for that (`none`); **copy what it printed, and never leave a segment out**. Writing them all out costs you nothing over writing out most of them, and a missing name is something the user can see — a missing row is not.

   **A segment beginning with `⚠` is never dropped, and neither is `(audit unavailable)`.** Those are not decoration sitting outside the named columns; they are the audit telling you something went wrong, and dropping them leaves the user holding only the parts that said nothing did.

   **Any segment carrying content is reproduced word for word.** Only `pass` and the CLI's own empty-value word may be compressed. The segments saying "nothing here" are the cheap ones to keep, and the one saying something is the one worth dropping — so this rule is deliberately asymmetric: **the more a segment has to say, the less freedom you have with it.**
3. **Then open a separate "hub assessment" section** — deduplicate, and annotate each item with your preliminary judgment (holds / does not hold + why / needs the user's ruling). **Every item carries the observations it came from**, by spoke and number (`safety 2, 3; feasibility 9`), and **every observation appears against at least one item**. Two spokes' worth of numbered observations either all show up in that column or the ones that did not are visible at a glance — which is the point: without the numbers, an observation that quietly failed to make it into the assessment cannot be told apart from one you judged and dismissed.

### Merging multiple runs

**Take the union, not the intersection.** Mark the occurrence count per item (`3/5` style), but **do not use occurrence count as importance** — something seen once may be severe, and something seen every time may be a false positive. **Importance is always judged by the hub after opening the file, never by vote count.**

### Three things you must verify when assessing a report

**One: the audit table's tool-call column.** That is what it actually read, not what it says it read (the raw `toolCalls[]` sits in the response column of the result row; the audit table has already counted it for you). A spoke with zero tool calls produced a text-only review, and its claims about the code should be discounted.

**Two: any claim about safety or correctness — open the file and verify it yourself before passing it on.** Do not report a spoke's claim to the user as a conclusion.

**Line numbers must be re-verified.** A spoke's citations can be off by anywhere from a few to dozens of lines while **the description of the content is usually right** — usable at the fact level, unusable at the location level. **A wrong location is not a hallucination** (a hallucination is "that passage does not exist in that file at all"), and the two are handled differently: a hallucination calls for a rerun or a different model, a wrong location only needs you to locate it again. **Mistaking a wrong location for a hallucination throws away an entire usable output.**

**This applies to the line numbers you write, too.** Re-verifying a spoke's citation and then citing it from memory a few paragraphs later puts the drift back in under your own name — and yours carries more weight with the user, because you said you opened the file.

**Three: when verifying a spoke's citation, a comment is not evidence.** "The spoke says a comment backs this conclusion" is not enough — you also have to verify **whether what the comment says still holds**. Comments drift away from the code, and a drifted comment reads exactly like a correct one, so verifying only that "the comment exists and matches" turns a wrong claim into an accepted one. The first item of the MUST checklist in AGENTS.md, "a filename, a comment, or a line number is not enough", was written for authoring plans; here it extends to accepting a spoke's citations.

**A spoke reporting "I could not read X" is a correct report, not a false alarm.** It names a file you did not put on its list, which makes it your gap and not its mistake — filing it under "false alarm", or quietly resolving it yourself and moving on, hides the one signal that tells you the allowlist was wrong. Resolve it if you can, and still say plainly that the list was short.

### Reading the audit table

| Column | Meaning |
| --- | --- |
| `Tool calls:N (allowed N / rejected N)` | How many reads, how many rejected — statistics from the run's `toolCalls[]`. **Printed first**, ahead of the closing line |
| `Closing line:` | pass / fail |
| `Observations:N` | The item count; `uncountable` means the format could not be recognized — go read the original |
| `Cannot-verify section:` | Whether that section was written per the template. **When judging output quality, look at how specific this section is** (for example, noting per item which conclusion depended on which unreadable file), not at the observation count — counts are unreliable, since overlap and padding both inflate them without indicating quality |
| `Template placeholders:<literal>×N` | The report still contains a template placeholder's literal text (the spoke forgot to fill it in). **It only hurts that field's readability — the observation content is usually still intact** — check the original first to see whether it's just a header field turned into noise. Prints `none` when there are no hits |

**If the columns are preceded by `⚠ Zero source reads (allowed N file(s))`** — see "what to do on zero reads" below, and handle that before reading any other column.

### Why the "Citations outside allowlist" column is gone

0.3.2 dropped this column, not by oversight — each of the three candidate questions has a better place to be answered: "did the spoke read something it shouldn't have" is hard-blocked by the allowlist before it ever reaches audit; "did the hub's list have a gap" is answered more fully by the cannot-verify section; the remaining question, "did it cite something it never read", needs to distinguish **citing** from **paraphrasing** — that is a judgment about content, not something the engine should be deciding.

This column **never once caught a genuine hallucination**: what it caught was usually the spoke copying an abbreviated path out of the material, relaying a path the material mentioned while stating it could not read it, or mixing absolute and relative paths.

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

## 7. Artifacts stay; there is nothing to clean up

Tickets and results live in SQLite; there is no directory on disk to tidy. **You neither need to nor should delete them** — those results were paid for, and the next round simply uses a different ticket-id (§5).

Lens definitions stay too; you will use them again.

---

## When something goes wrong

| Symptom | What to do |
| --- | --- |
| The report's numbers look wrong | Stop at `--dry-run` and check `_dispatch.md` |
| Failure partway through | **There is nothing to read midway** (§5). Wait for the CLI to return; the reason will be in its output. Rounds that completed are still billed and still recorded |
| A genuine failure or timeout | **Ask the user whether to rerun; do not rerun on your own** — a rerun means paying again, and what was spent before the interruption is unrecoverable |
| Hitting 429 | Rerun with `--concurrency 1` |
| Poor report quality | Rerun with a different model, or run the same configuration again and take the union (see "how to run it 2–3 times" in section 3) |
| Missing API key | The user has to run `dowafu key` and store it in the database (this version no longer reads `.env` or environment variables). **Do not set it for them — those are their credentials** |
| `dowafu` not found | **Not found does not mean not installed** — see §1.5; usually the sandbox is not reading the home directory |
| `Operation not permitted` | Blocked by your host's sandbox, **not a problem with the ticket or the command**. Allow it per the prompt and run again |

**If you hit any anomaly, tell the user** — do not swallow it or work around it silently.
