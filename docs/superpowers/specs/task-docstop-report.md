# docs-top cleanup — apply report

## Edits applied

| # | File | Change |
|---|---|---|
| 1 | `CLAUDE.md` L11 | "(0001–0025)" → "(0001–0035)" |
| 2 | `CLAUDE.md` Commands block | `pnpm dev` comment updated to include "research :3002" |
| 3 | `CLAUDE.md` L54 | `@wabi/research` bullet rewritten: always-on NestJS service (ADR-0034, :3002), run via `pnpm -F research dev` / `start:prod`, providers note preserved |
| 4 | `README.md` ADR line | "(0001–0025)" → "(0001–0035)" |
| 5 | `README.md` research table row | "Standalone research worker." → "Always-on NestJS service (:3002, ADR-0034)." |
| 6 | `docs/ARCHITECTURE.md` | "`/admin/drafts`" → "`/admin/strategies`" in Application processes |
| 7 | `docs/ARCHITECTURE.md` | Added `research` NestJS service (:3002, ADR-0034) to Application processes component list |
| 8 | `docs/ARCHITECTURE.md` | Added `research` to deployment topology diagram with arrow to bot strategy-admin API |
| 9 | `docs/ARCHITECTURE.md` | Extended ADR index from ~0022/0025 through 0035 (added 0023–0024, 0026–0035) |
| 10 | `docs/agents/domain.md` | Removed `src/<context>/docs/adr/` instruction; replaced generic file-structure example with wabi layout (root CONTEXT-MAP.md, docs/adr/, docs/contexts/{wellbeing,accounts,community}/CONTEXT.md, packages/) |
| 11 | `docs/contexts/wellbeing/CONTEXT.md` | Merged Screened-record write two-paragraph definition into one (preserved all factual content including ADR-0028/0029/0031, transport-agnostic, proof token, `_Avoid_:`) |
| 12 | `docs/contexts/wellbeing/CONTEXT.md` | Tightened Spoke and Tool definitions (removed redundant restatements, preserved all facts and `_Avoid_:` lines) |
| 13 | `docs/PLAN.md` L7 | Added `packages/research` to monorepo package list; left "Vercel AI SDK" line untouched |
| 14 | `docs/PLAN.md` Task 2 Files + Step 1 | `prisma/schema.prisma` → `packages/shared/prisma/schema.prisma` (descriptive text only; historical scaffolding code blocks left intact) |

## Items NOT applied

None — all 11 numbered edits from the approved spec were applied. Items 2 and 3 were merged into a single bullet edit. The `git add prisma/schema.prisma` line in the bash code block (Task 2 Step 3) was intentionally left as-is (historical scaffolding code block per instruction).
