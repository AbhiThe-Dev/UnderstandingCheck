# Blind test cases

These transcripts measure what the analyzers catch on conversations they were **not** written
around. The cases in `src/cases.ts` were written alongside the rules, so their perfect score is
optimistic; these are the honest check.

## Rules for whoever writes a case

- Do not read `packages/core/src/analyzers/`, `packages/core/src/text.ts`, `src/cases.ts` or the
  prompts before writing. Write the conversation the way your team actually talks.
- Never change rules or prompts because of a blind case. If a case reveals a gap, write a *new*
  development case in `src/cases.ts` for the fix, and keep this one unchanged.

## Format

One folder per case, e.g. `blind/refund-partial/`:

- `transcript.txt`: one turn per line, `Speaker: text` or `Speaker (Role): text`, optionally with a
  timestamp: `[0:01:15] Priya (PO): text`. Roles: PO, Developer, Designer, QA, Stakeholder.
- `expected.json`:

```json
{
  "repo": "approvals",
  "featureDescription": "optional, what the meeting is about",
  "surfaced": ["false_alignment"],
  "notSurfaced": ["direct_disagreement"],
  "notes": "Why: they agreed to reset the status, but approval also grants portal access."
}
```

`repo` is `approvals`, `billing` or `null` (the sample repositories in `../repos`). `surfaced`
lists what a careful engineer in the room should have raised, by category:

| Category | Meaning |
|---|---|
| `direct_disagreement` | Two people (or a person and an earlier decision) want incompatible behavior |
| `false_alignment` | Someone agreed, but a consequential detail means they may expect something different |
| `codebase_conflict` | A proposal conflicts with what the existing code does |
| `hidden_assumption` | Reusing code whose side effects nobody mentioned |
| `missing_specification` | The single most consequential behavior nobody specified |

Use `[]` for conversations where nothing should be raised. Those matter as much: they catch false
alarms.

Run: `pnpm eval:compare --blind` (add `--modes heuristic,tiered,llm`; the AI modes need `OPENAI_API_KEY` and cost money).
