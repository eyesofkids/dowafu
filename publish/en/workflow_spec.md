# Workflow Specification

## Plan → Implement → Accept (hub-and-spoke form)

> A planning document is a lossy projection of the decision process; whoever holds the live context is the cheapest one to do the work. This section is organized accordingly: planning and rulings stay in the hub, where the context lives; execution goes to ticket-driven spokes; quality calls are settled by numbers.

### Roles

| Role | Responsibility | Authority |
| --- | --- | --- |
| **User** | Whether to do it, the goal, state changes (start / block / terminate) | Discretion needs **no justification**; one sentence takes effect |
| **hub** (the long conversation holding the context) | Keeping discussion focused, writing plans, issuing tickets, merging spoke reports, comparing outcomes against the original intent and analyzing the gaps | **Versions are cut only from the hub** |
| **spoke** (ticket-driven session) | Implementation (= review + implement), measurement (benchmark), hole-finding (optional) | No version authority, no status field, no ruling authority |

### Flow overview

```
0. Decision discussion (hub + user) → decision document
1. Planning (hub, per the MUST checklist) → plan document → user approves directly
   (Optional: the user calls for hole-finder spokes — need-to-know tickets, producing
    observations rather than verdicts; skills: `/find-holes-external` for external
    dispatch, `/find-holes` for in-process sub-agents)
2. Implementation (spoke, opening with "implement per document X") → done when
   `pnpm run test`/`lint`/`tsc`/`build` are all green → report + runbook
   (wrap-up skill: /wrap)
3. Hot patching (same session, kept alive until the patch wave ends) → append to
   issue_log per fix; do not retroactively sync report/runbook
4. Acceptance (user): behavioral acceptance (manual test per the runbook) + diff review
   (faithful to the plan, nothing smuggled in) + business judgment → commit/PR
```

### Document discipline

- Six document types, each with one job: **decision** records why / **plan** records how / **facts** (append-only) records verified facts / **report** records delivery state (not edited after it is produced) / **runbook** records manual test steps / **issue_log** records the patch ledger (append-only; messy is normal).
- A new version writes only the differences; background gets one line citing the decision document, never a restatement.
- Changing a document's status field is the user's authority alone; **a document must not define its own conditions for being overturned** ("this document can only be superseded by X" is a red flag).

### Three sourcing rules (against smuggling)

1. "Per the user's ruling / already settled" **must carry its source** (the exact words, when, and what question it answered); without a source it counts as unsettled. Procedural replies ("not yet", "hold on") must never be promoted into substantive decisions.
2. An acceptance threshold **must carry its derivation** (a measured baseline from the same mechanism, or a number the user specified); a number the model made up is invalid. The baseline used to calibrate a threshold must come from the same mechanism — change two variables at once and the threshold is the first thing to break.
3. Citing precedent **hands over the ruler, not the corpse**: a ruling transfers only under "same problem + same cost structure"; "that one died, so this one will too" is not an argument.

### Quality-bet clause

Choices of model, prompt, or calling mechanism are settled by benchmark: fix the threshold beforehand, never relitigate it afterward; do not force adoption of something that missed the threshold; file negative results together with the result files, and any later proposal of the same kind must first address the existing measurements.

### Implementation-session discipline

- Open by listing todos (TodoWrite — the anchor that survives context compaction); delegate large read-heavy reconnaissance to sub-agents (a context firewall).
- **Do not use compact** (it is lossy, and once compacted a hot session has lost its value): when context runs short → wrap up at the last natural breakpoint — if the work is done run `/wrap`; **if it is not done run `/wrap` in handoff mode** (write a handoff document `handoff_<topic>.md`; each later handoff opens a new versioned file `handoff_<topic>_v<n>.md` whose header states which one it supersedes — never append to the old one) → close the session → a new session cold-starts from the plan plus the handoff. If a conversation opens with "This session is being continued" → re-read the plan; do not trust the specifications in a summary.
  **Whether context is "running short" is the user's call — do not declare it on your own hunch.** A model cannot measure its own context, and subjective judgments produce far more false alarms than hits. Unless the user says so, or there is an actual number, only mention "want to wrap up?" at a natural breakpoint — do not keep raising it, and above all do not interrupt work in progress because of it.
- Deviating from the plan during implementation → record it in the report (the "corrections made during implementation" section); incidental fixes in a file you are already touching (an unrelated lint error, say) are allowed — log them in issue_log.

### MUST checklist when writing an implementation plan

Every item below needs an explicit answer in the plan, or an explicit note that the gap is a **deliberately accepted trade-off**. None may be left blank:

1. **Citing means verifying**: every claim of "the existing mechanism already covers this / zero changes needed / there is already an X filter" requires actually opening that file and following the **complete semantics** through (branches, unions/side tables, fallback paths) — a filename, a comment, or a line number is not enough. When citing, include the key semantics that support the conclusion, not just the location.
   **This rule applies equally when you are accepting a spoke's citations** (in-process and external alike): verifying "the comment the spoke quoted does exist" is not enough — you must also verify "**whether what the comment says still holds**", because comments drift away from the code. A real case: a spoke cited a file-header comment claiming "this component sits outside the provider's scope"; the hub confirmed the comment existed and matched word for word, and judged the claim factually correct — but that architecture had long since been moved inside the provider, and **the conclusion was wrong**.
2. **Failure states and time windows**: for each mechanism, write down what happens when it fails — before the scheduled job has run? after retries are exhausted? under a concurrency race? "At most N times" with nothing after it about "and when they are used up…" is an unfinished design.
3. **Gate ordering for billable calls**: for any call that incurs external API cost (LLM / STT / image generation / embedding), the quota or gate check must come **before** the call; "count it only after success" additionally requires a read-only pre-check up front, and must answer "what happens on each request after the limit is hit, and what does it cost".
4. **New-endpoint protection is mandatory**: any new API route must explicitly state its auth level, rate limit, and request-body size cap — all three; "not needed" also has to come with a reason. If the project already has a fix for a vulnerability of the same shape, cite that document as the standard.
5. **Implementability check**: for every "the backend validates X / the code guarantees Y", answer whether the backend can technically do it and what it depends on; where it cannot, replace it with something implementable (for example a two-stage design: a coarse pre-filter followed by an exact decision).
6. **Bidirectional lifecycle**: any "list/delist, enable/disable, expiry" mechanism needs both directions defined (writing the delisting scan but not the listing backfill = a gap); and for index-like derivatives (embeddings, variants, caches, projections), state whether they all follow along when the state changes.

### Independent review

Plans are not sent to any independent session for review, and restoring that practice must not be proposed; the "guidance for the review gate" found in historical `_docs` no longer applies. A clean perspective exists solely in the form of hole-finder spokes (see the two skills in step 1 of the flow overview).

---
