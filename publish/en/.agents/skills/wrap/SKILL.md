---
name: wrap
description: Wrap-up and pre-acceptance checks for an implementation session — self-check that the project's completion conditions are all green, confirm report/runbook/issue_log are in place, produce the user's manual-test checklist and a diff-versus-plan summary, and advise switching sessions (never compacting). Use when an implementation session finishes, or when context runs short.
metadata:
  derived-from: ".claude/skills/wrap/SKILL.md"
  derived-from-sha256: "47e3cf2badabdd09a84503e8d204de63fa7c5819d88d4a17758078f1e356a6b2"
---

# wrap — implementation wrap-up

You are an implementation spoke, wrapping up. First decide which mode you are in:

- **Completion wrap-up** (default): the work items are done → follow sections 1–4.
- **Mid-work handoff**: context is running short and the work is not done → go straight to section 5 ("all green before finishing" does not apply).

## 1. Self-check that everything is green

The completion conditions are **whatever that project's AGENTS.md defines**. If it defines none, look at `scripts` in `package.json` and **run whichever exist** (`test` / `lint` / `typecheck` / `build`).

- **Do not add tooling just to make the list look complete** (if the project has no linter, do not install ESLint)
- **Do not skip an existing script because it "looks unnecessary" either**

Two execution details:

- Run tests **only for the modules you changed this round**; see that project's AGENTS.md testing rules for how to scope it. Never pipe into `| sort` / `| head` / `| tail` — that swallows the failure output
- If `typecheck` and `build` are two separate scripts, **run them separately, never merged**. Build configs commonly exclude test files, so only typecheck covers them; merged, you also lose the ability to tell "the build broke" from "a test has a type error"

If any of them is not green: fix it before continuing the wrap-up. **Never finish in the red.**

## 2. Document check

- **report**: produced? Does it have a "corrections made during implementation" section (where the implementation deviated from the plan)?
- **runbook**: produced? Does it contain manual steps for the parts a machine cannot test (environment, paths, order of operations, expected results)?
- **issue_log**: is every fix made after this round's report was produced logged, one entry per fix? (report/runbook are not edited retroactively — see the document discipline in AGENTS.md)

## 3. Produce the acceptance package (the final message to the user)

Present it in this order:

1. **Manual-test checklist**: extract from the runbook the items the user has to verify by hand and list them one by one (steps + expected result). Do not make the user go dig through the runbook.
2. **Diff-versus-plan summary**: the list of files actually changed against the list of files in the plan, matched up one by one; **explicitly flag anything changed beyond the plan** (smuggling is an acceptance red line).
3. **Open items**: problems found during implementation but not handled (logged in issue_log for later, or needing the user's ruling).

## 4. Wrap-up reminders

- **Do not recommend committing** — per the Git safety rules in AGENTS.md, present the diff to the user for confirmation first.
- **Do not compact**: if context is already tight, say so plainly — "this session should finish here; later fixes can reuse this session (hot patching); if this session has gone cold or been cut, open a new one and cold-start from report + issue_log".
- During a patch wave: append to issue_log per fix.

## 5. Mid-work handoff (context running short, work unfinished)

**Do not compact** — after compaction the map has been lossily squeezed and a hot session has lost its value; write the handoff document instead, then close the session.

1. Update the todo statuses (done / in progress / untouched).
2. Write the handoff document `_docs/<area>/handoff_<topic>.md` (the first one carries no version number; later ones are `handoff_<topic>_v<n>.md`).
   **One new file each time — never append to the old one.** The old one stays as history and is not edited.
   The header states the date, why the handoff is happening, the branch state, and **a link to the previous one plus what it supersedes** (for example: "previous: `handoff_<topic>_v4.md` — its content is complete; this file supersedes it"). The body covers:
   - The plan's path, and which work item you got to
   - The list of half-finished files and the state of each (for example: "X.ts changed, untested"; "Y.ts half changed, missing Z")
   - The current red/green state (which tests pass, which fail, and why)
   - The next step (specific down to "open which file and do what")
   - Environment notes and traps (dev server port, flaky tests, workarounds)
3. Fixes completed this round still go into issue_log as usual.
4. Give the user a one-line resume command: "New session opener: `continue per <plan path>; first read <handoff path> and issue_log`".
