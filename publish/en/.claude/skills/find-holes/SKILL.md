---
name: find-holes
description: [Claude Code in-process dispatch only; in a VS Code environment use find-holes-external instead] Dispatch hole-finder spokes (sub-agents) against a plan document: the hub trims a need-to-know ticket, sends 1–3 sub-agents with different lenses to look for holes and feasibility problems, and collects their observations for the user to rule on. Usage: /find-holes <path to plan> [section or question to focus on]
---

# find-holes — dispatching hole-finder spokes

You are the hub. This skill hands a specified portion of a plan document to sub-agents with a clean perspective so they can look for holes.
**Spokes produce observations, not verdicts; whether to adopt them is the user's call.**

> **This skill covers in-process dispatch only.** When you need the heterogeneous perspective
> of an external model, or a review conducted against the real source code, use
> `find-holes-external` instead (it goes through the `dowafu` CLI, where spokes are read-only
> and governed by an allowlist).

## Steps

### 1. Read the plan

The file given as the argument. If the user named a section or question to focus on, take only
that range; otherwise take the settled-design sections (skip background, prior context, and
citations of already-settled facts).

### 2. Assemble the need-to-know ticket

Three things only:

- **The verbatim text under review** — embedded directly into the prompt, never given as a file path
- **The premise list** — marked "premises, not under review": decisions the user has already settled, and conclusions from verified facts. Give the one-line conclusion only, never the facts file
- **Specific questions** — 2–4 per spoke, for example "does the pairing rule in §3.2 have a hole under concurrency?"

**Never put into a ticket**: the chain of historical versions, superseded planning documents, decision-process background, or any `_docs` path. Precedent may only be given as a one-line criterion ("hand over the ruler, not the corpse" — see the three sourcing rules in AGENTS.md).

### 3. Present the dispatch plan, then stop and wait for confirmation

**Do not call Agent without approval.** Pick from the three lenses according to what the plan contains (all read-only):

| agent | lens |
| --- | --- |
| `hole-finder-feasibility` (sonnet) | Feasibility, implementability, citing-means-verifying |
| `hole-finder-safety` (opus) | Concurrency races, failure states, input validation, data leakage |
| `hole-finder-cost` (sonnet) | Gate ordering for billable calls, pre-checks, over-limit behavior |

For a plan none of the three fits, use the general-purpose `hole-finder` (sonnet) and specify a custom lens yourself in the prompt.

What to list for the user:

- How many to dispatch (1–3), and each one's agent and lens
- Each one's model (use the agent's default. When the holes in question need deeper reasoning, you may upgrade to opus/fable via the `model` parameter on the Agent call, with your reasoning stated)
- A summary of the ticket contents (which passages, which premises, which questions)
- **A per-question "question → which file holds the answer → is it on the list?" table (mandatory)**

Do not split the questions and the file list into two separate blocks — that makes it impossible to see which question has no file behind it:

| Q | Question | Which file holds the answer | On the list? |
| --- | --- | --- | --- |
| 1 | Is the change in §3.1 feasible | `prisma/schema.prisma` | ✅ |
| 2 | Does §2's description of the current state match the code | `lib/a.ts`, `lib/b.ts` | ❌ **must be added** |

**This is the most common mistake** — "asking a question without providing the file needed to answer it". Listing it per question lets the user see at a glance what is missing. **That column is not a formality; it is currently the only thing standing between you and a missing file.**

**Before writing a path into that column, confirm the answer is in that file** — grep for the symbol, or open it. Filled in from memory the column catches nothing: a plausible-looking filename passes the format check exactly as well as the right one does, and the difference only surfaces a full dispatch later. **Two spokes may end up with the same files, but say why** — an identical list is a result you can explain, not a starting point.

**Any change the user makes to the count, the models, or the lenses is followed without argument.**

### 3.1 Once confirmed, every prompt must contain

- **The ticket contents** (step 2)
- **The list of source-code files the spoke may read**, with an explicit prohibition on browsing any other document under `_docs/`

  When trimming that list, **ask yourself question by question: "where is the answer to this one? is that file on the list?"** Matching files to the lens's name (giving the safety lens the security-related files) produces the wrong list — **the lens is the angle you look from, the list is the material you look at**. If the list does not line up with where the answers live, the spoke is physically incapable of answering correctly. **A missing file is the dispatcher's failure, not the spoke's.** **Each spoke's list is trimmed against its own questions** — do not give two lenses the same list because one list is less work to assemble; whatever only one of them needed is what goes missing.
  **A file you did not open is not evidence that the answer is elsewhere** — if you cannot point to the file that answers a question, that question has no file behind it yet, whatever the table says.

- **Put the large files last on the list** (ascending by file size). Spokes read files in list order, and every round resends everything read so far, so the earlier a file sits, the more times it is billed again — the gap can approach a factor of two. In-process dispatch has a different context mechanism and the effect may not be the same, but ordering costs nothing and has no side effects; doing it anyway cannot hurt.

- **Output format**: a list of "observation + evidence (file:line, or reasoning)". **Never** conclusions or verdicts, severity ratings, "should be changed to" alternative designs, or adoption recommendations; anything uncertain is written as a question, not as a defect.

### 4. Collection — summary by default, verbatim the exception

The user must see each spoke's content, labeled with lens and model. **Synthesis is the default**, satisfying four required conditions:

1. **Declare the trade-off explicitly** — state at the top of the section that "this is a summary, not verbatim"; never summarize silently
2. **The reading must cover every item, skipping none** — every observation from every spoke has to appear in the "hub reading" below, which is what replaces verbatim reproduction as the source of auditability: an original not laid out in front of the user does not mean it went unread
3. **The original is still in this conversation turn** — the sub-agent's full response stays in context, and it can be pasted back in full if the user asks
4. **This only holds while the original can still be found** — once it has fallen out of context there is no original to check against

> What this rule guards against is not "no original exists", it is **the hub cherry-picking what suits it**. Satisfy those four and a summary guards against it just as well; what has to be preserved is the purpose, not the "verbatim" mechanism itself.

**Reproduce it verbatim in two situations**: the original has fallen out of context (there is no original left to check, so a summary cannot satisfy condition 4), or a single report is short enough that summarizing would be overkill. Everything else defaults to a summary.

**If you cannot meet condition 2, dispatch fewer spokes rather than falling back to verbatim** — the problem is dispatch scale, not presentation; do not treat "not confident" as a reason to revert to full reproduction.

Then **open a separate "hub assessment" section**: deduplicate, and annotate each item with your preliminary judgment (holds / does not hold + why / needs the user's ruling).

### 5. After the user rules

You revise the plan for the items that were adopted (a new version writes only the differences). **A spoke's output never becomes a document version directly.**

## Three things you must verify when assessing a spoke's report

**One: any claim about safety or correctness — open the file and verify it yourself before passing it on.** Do not report a spoke's claim to the user as a conclusion.

**Two: a comment is not evidence.** "The spoke says a comment backs this conclusion" is not enough — you also have to verify **whether what the comment says still holds**. Comments drift away from the code, and a drifted comment reads exactly like a correct one.

**Three: line numbers must be re-verified.** A spoke's citations can be off by anywhere from a few to dozens of lines while **the description of the content is usually right**: usable at the fact level, unusable at the location level.

> **A wrong location is not a hallucination.** A hallucination is "that passage does not exist in that file at all", and the remedy is a rerun or a different model; a wrong location only needs you to locate it again. Mistaking the former for the latter throws away an entire usable output.

**A spoke reporting "I could not read X" is a correct report, not a false alarm.** It names a file you did not put on its list, which makes it your gap and not its mistake — filing it under "false alarm", or quietly resolving it yourself and moving on, hides the one signal that tells you the list was wrong. Resolve it if you can, and still say plainly that the list was short.

## Red lines

- A spoke's observations **must never touch "whether to do it"**. If one produces a terminate/block style conclusion, discard that conclusion, keep only the factual part of it, and note this in your report.
- **Never change a plan's status field on your own because of a spoke's observations.**
