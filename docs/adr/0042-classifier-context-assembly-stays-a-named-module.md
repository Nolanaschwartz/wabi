# Classifier context assembly stays a named module, not inlined into the coaching turn

`ClassifierContextAssembler` keeps owning the assembly of the safety classifier's disambiguation context — gathering the tilt signal (`TiltService.hasActiveSession`) and the recent session-buffer turns into the `ClassifierContext` the classifier defines. We **considered and rejected** inlining its ~8 lines into `CoachingService.runTurn`, where it has its single caller.

This is a deliberate keep, recorded so a future architecture review does not re-suggest the inline (this one did, despite the in-file comment).

## Why

- **It is the one named home for "what the classifier needs to know about this person."** The classifier owns the `ClassifierContext` shape, its prompt envelope, and the user-message clamp; the assembler owns *gathering* the inputs. Inlining would scatter that gathering into the middle of the 12-dependency gate sequence (ADR-0030), next to burst-coalescing, trace latching, and routing — concerns it has nothing to do with.

- **It keeps the crisis/classifier path off Wellbeing data sources.** The assembler is what lets the `crisis` module stay free of a dependency on `TiltService` and the session buffer: it lives in the coaching module and adapts Wellbeing reads into the classifier's shape. The decoupling is the point, not an accident of where the code sits.

- **The interface is a clean, fail-safe test surface.** `assemble(userId, session)` always returns an object so every screening call carries context (empty when cold), and every fetch is best-effort — a throwing `hasActiveSession` degrades to `inTiltSession: false` rather than blocking the classifier (ADR-0021). That fail-soft gathering is worth asserting in isolation.

## Scope and bounds

- This rejects the **inline**, nothing else. The assembler's interface, behaviour, and its single call site are unchanged.
- It is shallow by mass (one method, ~8 lines) and has exactly one caller today — a *hypothetical* second screening site, not a proven one. The keep rests on the decoupling + named-home + fail-safe-test-surface reasons above, not on present reuse.
- Accepted trade-off: coaching's own tests mock `TiltService` to reach the assembler through `handle()`. That is the cost of the seam; it is small and the assembler has its own focused spec.

## Consequences

- A future review will again see a shallow, single-caller module and be tempted to inline it. That temptation is recorded here as already-weighed: the value is the crisis-off-Wellbeing decoupling and the isolated fail-safe test surface, not line count.
- If a second caller ever needs the same classifier context (a second screening surface), the seam is already in place and this ADR's premise only strengthens.
