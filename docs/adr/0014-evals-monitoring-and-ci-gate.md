# Evals are sampled monitoring + a CI safety gate — never a live response blocker

Automated evals (safety, tone, personalization, grounding, helpfulness) score coach responses, but they **cannot** gate an individual live response: by the time an eval runs, the reply is already formed and (in the original design) already sent. Treating the "safety eval" as a guardrail gives false comfort. So evals are positioned explicitly as two things, neither of which is a live blocker:

## The blocking guarantee lives elsewhere

Crisis safety is enforced by the **crisis-detection module (Task 25 / ADR-0006)**, which runs *before/at* generation and can stop or replace a reply. Evals never substitute for it.

## Evals = monitoring + CI gate

- **Live: sampled** (e.g. 5–20% of turns, not every turn) — alert on safety/grounding score drops; any low-safety turn is queued for human review. This bounds latency and cost.
- **CI: an offline golden dataset** of crisis messages, gamer hyperbole, and normal coaching, run against the crisis-detection + coach. **Crisis-handling and grounding must clear a threshold before deploy** — this catches safety regressions *before* they ship, which production-only scoring cannot.
- The eval model uses the swappable OpenAI-compatible provider (ADR-0009), not a hard-coded client.

## Why

For a product whose core risk is mishandling a crisis, the valuable assurance is a *pre-deploy* gate plus the blocking detector — not after-the-fact scoring of every live message. Sampling trades 100% live coverage (low value once you have a CI gate and a blocking detector) for affordable monitoring and a real regression gate.
