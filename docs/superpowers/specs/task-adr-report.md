# ADR Accuracy-Only Cleanup — Task Report

Date: 2026-06-16

## Changes Applied

| # | File | Change |
|---|------|--------|
| 1 | `docs/adr/0019-nestjs-for-the-bot-backend.md` | `/admin/drafts` → `/admin/strategies` in opening paragraph |
| 2 | `docs/adr/0005-paid-only-with-trial-and-safety-carveout.md` | Two fixes: (a) opening sentence: `hasActiveAccess` "field" → "computed accessor (see `packages/shared/src/access.ts`), derived from `trialEndsAt`/`subscriptionStatus`"; (b) Consequences bullet: same framing correction |
| 3 | `docs/adr/0011-trial-and-access-lifecycle.md` | Added note to opening line: "`hasActiveAccess` is a computed accessor in `packages/shared/src/access.ts`, derived from `subscriptionStatus` and `trialEndsAt` — not a stored field" |
| 4 | `docs/adr/0001-non-clinical-positioning.md` | `see \`CONTEXT.md\`` → `see \`CONTEXT-MAP.md\` → \`docs/contexts/<context>/CONTEXT.md\`` |
| 5 | `docs/adr/0013-no-durable-transcript-store.md` | `AiConversation` metadata `(sessionId, topic)` → `(userId, topic)` |
| 6 | `docs/adr/0017-self-hosted-embeddings-from-day-one.md` | Opening example `TEI/Infinity serving \`bge-base-en-v1.5\`` → `serving \`nomic-embed-text-v2-moe\`` (matches the file's own 2026-06-06 amendment; 768-dim and amendment text untouched) |
| 7 | `docs/adr/0012-strategy-quality-gate.md` | `(\`research-cron\`, \`session-mining\`)` → `(the research worker (ADR-0034) and the session sweeper's draft-submission path)` |
| 8 | `docs/adr/0009-self-hosted-data-swappable-llm.md` | Added one-sentence `> Update:` pointer at end of Consequences: notes OpenAI-for-PoC posture is superseded by privately-managed single-tenant endpoints per ADR-0017 2026-06-06 amendment; original decision text untouched |
| 9 | `docs/adr/0021-graceful-degradation-and-safety-floor.md` | Two fixes: (a) safety-floor paragraph: `local file (crisis-resources.json)` → `hardcoded \`RESOURCES\` const in \`crisis-resources.service.ts\`, compiled into the bot image`; (b) Consequences bullet: same mechanism description, removes the JSON file reference |
| 10 | `docs/adr/0023-served-region-scope-and-crisis-resource-coverage.md` | Consequences bullet: `\`crisis-resources.json\` (Task 30) ships with…` → `The hardcoded \`RESOURCES\` const in \`crisis-resources.service.ts\` ships with…` and named `resourcesFor(locale)` as the selection logic |

## Not Applied

- `docs/adr/0027` — explicitly excluded per task instructions (handled separately as a tracking issue).

## Notes

- Item 3 (ADR-0011): the exact phrase "replaced by a single `hasActiveAccess` boolean" does not appear in 0011's body; the spec's target phrase is in 0005 (fixed there). For 0011, the correction was applied to the opening metadata line where the accessor is first introduced, which is the accurate factual anchor point.
- Item 8 (ADR-0009): conservative approach taken — one `> Update:` sentence appended after Consequences; no original decision or rationale text was altered.
- All changes are accuracy-only; no decisions, rationale, or narrative were rewritten.
