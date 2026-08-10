# dowafu

A local CLI that sends a section of a design doc to external LLMs for review. The caller
writes a ticket, the CLI calls each provider, and each reviewer — a *spoke* — reads only
whitelisted files and returns observations with evidence. See [`README.md`](./README.md)
for what it does and how to run it; this file is for working on it.

**Source comments and everything under `publish/` are written in Traditional Chinese.**
Outward-facing documents (`README.md`, this file) are in English.

## Commands

| Command | What it runs |
| --- | --- |
| `npm run test` | `tsx --test 'src/**/*.test.ts'` |
| `npm run lint` | `eslint .` (flat config, `js` + `typescript-eslint` recommended) |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit`, **covers test files** |
| `npm run build` | `tsc -p tsconfig.build.json` + `chmod +x dist/cli.js`, **excludes `*.test.ts`** |
| `npm run dispatch <ticket-dir>` | runs `src/cli.ts` directly, no build step |
| `npm run check:publish` | scans `publish/` before copying it into another project |
| `npm run verify:providers` | real minimal requests against each provider API. **Costs money**, run by hand |

Done means **test / lint / typecheck / build all green**.

**`typecheck` and `build` must not be merged.** `build` uses `tsconfig.build.json`, which
explicitly excludes `src/**/*.test.ts` — only `typecheck` covers the tests. Their
intersection was once empty, and type errors in test files survived a whole release
because of it. Merging them would also stop distinguishing "the build broke" from "a test
stopped type-checking".

`no-explicit-any` stays an error. When reading an untyped API response in `scripts/`,
declare the **minimal shape this script actually reads** — do not reach for `any`, and do
not blanket-cast to `unknown` and narrow it everywhere instead.

## Layout

| Path | What it is |
| --- | --- |
| `src/` | the CLI. Most modules have a sibling `*.test.ts` in the same directory |
| `src/adapters/` | per-provider call layer |
| `src/__fixtures__/` | test data derived from real dispatches, with project content removed |
| `scripts/` | verification scripts against live APIs, not part of `dist/` |
| `providers.json` | model whitelist and per-provider capabilities. **Ships with the package**; `--providers` is the only escape hatch |
| `publish/` | what gets copied into a project that wants to use this (see below) |
| `.claude/agents/` | reviewer definitions. **The CLI reads this path directly** — it is a tool-level path, not an agent-host convention |
| `tmp/` | tickets and spoke output, never committed (reports quote the document under review) |
| `dist/` | build output, never committed |

## `publish/`

`publish/` holds what a consuming project needs: skills for whatever agent works there,
the reviewer definitions the CLI reads, and `workflow_spec.md`. Install instructions are
in [`publish/README.md`](./publish/README.md).

- **Skills live in two directories.** `publish/.claude/skills/` and
  `publish/.agents/skills/` hold the same skills for hosts that look in different places.
  The `.agents/` copies are **derived**: same content minus the parts that only hold for
  one host. Each records the source file's sha256 in its frontmatter, and
  `npm run check:publish` recomputes it — **edit `.claude/skills/` first**, then revisit
  the derived copy.
- Everything is a **whole-file copy**; there is nothing to splice.
- `publish/` must not carry traces of a specific installation: absolute paths, private
  document filenames, project names, or measurements. `check:publish` scans for those.
- `publish/` is not in the npm `files` list by accident — it is, so that `npm i` gives the
  consumer both the CLI and the material to copy.

## Tests

- **Run only the modules you touched**: `npx tsx --test src/<module>.test.ts`. Do not pipe
  the output through `sort`/`head`/`tail` — that swallows failure messages.
- Real API verification lives in `scripts/verify-*.ts` (manual, costs money) and is not
  part of `npm run test`.
- Fixtures under `src/__fixtures__/` are structure extracted from real dispatches:
  `usage/` keeps only token counts and field names, `audit/` keeps only the report
  skeleton. The unredacted originals stay out of version control.

## Git

- **Ask before committing or pushing.** Show the diff and let the human decide.
- If `tmp/` is not gitignored, stop and ask — spoke reports quote the document under
  review. Do not edit `.gitignore` on your own.
