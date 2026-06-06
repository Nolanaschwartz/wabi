# Evals are sampled monitoring + a CI safety gate — never a live response blocker

Automated evals (safety, tone, personalization, grounding, helpfulness) score coach responses, but they **cannot** gate an individual live response: by the time an eval runs, the reply is already formed and (in the original design) already sent. Treating the "safety eval" as a guardrail gives false comfort. So evals are positioned explicitly as two things, neither of which is a live blocker:

## The blocking guarantee lives elsewhere

Crisis safety is enforced by the **crisis-detection module (Task 25 / ADR-0006)**, which runs *before/at* generation and can stop or replace a reply. Evals never substitute for it.

## Evals = monitoring + a pre-deploy gate, both hosted in Langfuse

Evals **live in Langfuse** — one source of truth for the dataset, the runs, the scores, and their history. There is no parallel eval harness in code.

- **Live: sampled** (e.g. 5–20% of turns, not every turn) — Langfuse trace scoring; alert on safety/grounding drops; any low-safety turn is queued for human review. Bounds latency and cost.
- **Golden dataset = a Langfuse dataset** (crisis, paraphrased crisis, gamer hyperbole, normal coaching); golden runs are Langfuse **experiments**.
- **The automated gate is a *pre-deploy release gate*, not a per-PR CI build gate** (amendment below): a deploy-pipeline step calls the Langfuse API, runs the golden experiment, reads back crisis-recall / false-positive scores, and **aborts the release** on a threshold breach. Pinned, dated eval model; thresholds with margin.
- The eval model uses the swappable OpenAI-compatible provider (ADR-0009), not a hard-coded client.

> **Amendment.** Two changes from the original wording: (1) the gate is **pre-deploy** (blocks the Railway release), not "fail the build" on every PR — the LLM eval is slow/paid and need only gate production; the deterministic **tripwire** cases *can* stay a free per-PR check. (2) The gate **delegates to Langfuse** rather than being a separate code path. (3) **Timing:** wiring the automated assertion now is premature (the PoC model still swaps, ADR-0009), so it is **deferred to the launch gate** — until then, Langfuse evals (dataset experiments + live sampled scoring) are run and reviewed manually. Deferred, *not* dropped: the crisis-recall gate is a launch requirement. The blocking *runtime* guarantee remains the crisis-detection module (Task 25), unaffected by any of this.

## Why

For a product whose core risk is mishandling a crisis, the valuable assurance is a *pre-deploy* gate plus the blocking detector — not after-the-fact scoring of every live message. Sampling trades 100% live coverage (low value once you have a CI gate and a blocking detector) for affordable monitoring and a real regression gate.
