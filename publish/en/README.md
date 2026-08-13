# publish/ — the things meant to be copied into another project

Three kinds, each landing in a different place:

| Here | Lands in the target project at | What it is |
| --- | --- | --- |
| `.claude/skills/<name>/` | `.claude/skills/<name>/` | Skills — for hosts that read this directory |
| `.agents/skills/<name>/` | `.agents/skills/<name>/` | The same skills, for hosts that read the open spec directory |
| `.claude/agents/*.md` | `.claude/agents/` | Lens definitions — the source of each spoke's system prompt |
| `workflow_spec.md` | Project root | The plan → implement → accept workflow specification |

> **Do not relocate `.claude/agents/`.** That path is hardcoded in the CLI (`.claude/agents`
> under `--repo-root`) and has nothing to do with where your host reads from — the tool
> reads it, not the agent.

## Installation

```bash
TARGET=<path to the target project>
mkdir -p "$TARGET/.claude/skills" "$TARGET/.claude/agents" "$TARGET/.agents/skills"
cp -R .claude/skills/. "$TARGET/.claude/skills/"
cp -R .agents/skills/. "$TARGET/.agents/skills/"
cp .claude/agents/*.md "$TARGET/.claude/agents/"
cp workflow_spec.md "$TARGET/"
```

**Every file is overwritten whole**; there is no part that needs to be spliced together by hand.

> **Copy both `.claude/` and `.agents/` — do not skip `.claude/` on the grounds that "this
> project doesn't use Claude".** The `agents/` directory underneath is the CLI's data
> directory: the tool reads it, regardless of which agent you happen to use. If you skip it,
> a dry run aborts and prints the path it could not find (so it costs nothing), but you will
> have to come back and do it anyway.

Once installed, run **`preflight`** in the target project — it checks whether the wiring is
in place and whether the environment has silently disabled the workflow. These failures
**never raise an error**; they just quietly stop the workflow from taking effect.

**Skills are not guaranteed to be `/` commands.** Some hosts mount both directories
automatically and offer `/<name>`; some offer neither. If you cannot invoke it that way, name the file
directly: "follow `.agents/skills/preflight/SKILL.md`".

### How the two copies of each skill relate

The copy under `.agents/skills/` is derived from the one under `.claude/skills/` — **same
content, minus the passages that hold only for one particular host**. Its frontmatter
`metadata` records the sha256 of the source file, so if the source changes and the derived
copy does not follow, the pre-publish check will stop it. **Always edit the copy under
`.claude/skills/`**, then revisit the derived one.

## Wiring `workflow_spec.md` into the target project

Claude Code **reads `CLAUDE.md`, not `AGENTS.md`**; and the `AGENTS.md` spec itself
**defines no import mechanism at all**. Both readers have to be addressed separately, or one
of them silently misses the entire specification.

Add this at the end of the target project's `AGENTS.md`:

```markdown
## Workflow specification

See `workflow_spec.md` (project root). The `@` on the next line is Claude Code's import
syntax and loads that file automatically; other tools must open it directly.

@workflow_spec.md
```

Three details that raise no error when you get them wrong — they just quietly do nothing:

- **The `@` must not be wrapped in backticks** — wrapped, it is literal text and imports nothing
- The path is **relative to the file containing the import**, not to the working directory
- Imports can recurse, up to **four levels**; `CLAUDE.md` → `AGENTS.md` → `workflow_spec.md` is two

If the target project has no `CLAUDE.md`, create one containing the single line `@AGENTS.md`
(the officially recommended approach).

### If the project already has a workflow-specification chapter

Plenty of projects already carry one, pasted straight into the entry file — and possibly in
a different language from the pack you just installed, since each language pack ships its
own `workflow_spec.md`. Copying the file in on top of that leaves **two copies with nothing
keeping them in step**, and the one that governs every session is whichever the entry file
auto-loads: the chapter that was already there, not the file you just installed.

Pick one and remove the other:

- **Keep `workflow_spec.md`** (recommended): delete the old chapter out of the entry file
  and put the import above in its place
- **Keep the inline chapter**: replace its text with the installed `workflow_spec.md`'s, in
  whichever language you are standardizing on, and do not copy `workflow_spec.md` into the
  project at all

Either way the project ends up with **one copy**. Run `preflight` afterwards: it reports
which copy is actually in context, so a skipped decision here still gets caught.

## What must never appear here

The contents of `publish/` run somewhere that has no idea the source project exists, so they
must not contain absolute paths, the source project's name or its document filenames, commands
that only work in the source project, or measured figures and sample-size discussion (those
are evidence, not operating instructions).

One exception: the name `_docs/` may appear — it is the CLI's hardcoded spoke-forbidden
directory, a tool-level reserved name.

Run the source project's pre-publish check before syncing; it sweeps for all of the above.
