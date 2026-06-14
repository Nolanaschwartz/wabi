# The coaching safety floor stays in one service, not a typed intake/pipeline split

`CoachingService.handle` keeps owning the full DM turn — consent gate, crisis screening, access gate, and dispatch — as one linear sequence. We **considered and deferred** splitting it into a `DmIntake` module (consent + classifier) that mints an unforgeable `ScreenedTurn`, consumed by a separate `CoachingPipeline` so "no coaching without a clean classifier verdict" (ADR-0021) becomes a compile-time guarantee instead of statement order.

This is a deferral, not a rejection: revisit it if `handle` accretes new responsibilities and stops reading as one legible sequence.

## Why

The split's appeal is real — the fail-closed floor is the highest-stakes invariant in the repo and today it is upheld by the order of statements plus a comment, with no compile barrier. But three things make the split low-reward and non-trivial-risk right now:

- **The invariant is already test-locked where it can break.** `ClassifierService.classify` catches every failure and returns `'crisis'` (never throws), and that contract is covered directly: API error, empty output, blank output, unparseable output, and fail-closed-even-with-context all assert `'crisis'`. So the `Promise.all` that runs the classifier cannot reject and silently skip screening. A branded `ScreenedTurn` would harden the *call-site ordering*, but the failure mode it guards is the one already covered.

- **The split fights the latency fusion.** The crisis classifier runs in one `Promise.all` with strategy retrieval and the router's `prepare()` (ADR-0021: routing is downstream of safety but co-scheduled for latency). A clean `DmIntake.screen()` that owns `classify` would either pull it out of that block (a serial-latency regression on every turn) or absorb strategy + intent into "intake" — concerns that are not screening. The honest seam would have intake own the whole parallel block and return a screened bundle, which is a larger, less obvious change than the friction warrants.

- **After deepening the DM router (ADR-trace: prepare/dispatch refactor), `handle` is a 12-dependency linear gate sequence**, not a tangle. CoachingService no longer owns routing decisions, journal state, or intent plumbing. The residual god-method risk that motivated the split was substantially paid down by that change alone.

## Scope and bounds

- This defers the **module split + branded value-object**, nothing else. The crisis floor's behaviour, ordering, and tests are unchanged.
- The cheaper hardening the split would have delivered is already in place: the classifier's never-throws / fail-to-crisis contract is explicit and tested.
- If `handle` later grows a fourth or fifth distinct responsibility — or if a second entry point needs the same screened-then-coach sequence — the intake/pipeline split becomes worth its cost and this ADR should be revisited.

## Consequences

- A future architecture review will see a 12-dependency `CoachingService` and be tempted to split it. That temptation is recorded here as already-weighed: the blocker is the classify∥strategy∥prepare latency fusion, and the safety gain is small because the fail-closed contract is enforced at the classifier, not the call-site ordering.
- The fail-closed floor remains a property maintained by review discipline + classifier tests, not by the type system. Reviewers touching `handle` must keep the access gate **after** the classifier (the comment at the access-resolve call documents this).
