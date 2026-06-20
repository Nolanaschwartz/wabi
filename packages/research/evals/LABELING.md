# Relevance-gate labeling rubric

> **Status: DRAFT — operator owns and finalizes this file.** It is the independent ground truth for
> the gate eval (ADR-0040). It is **not** derived from the gate prompt; the prompt is the thing under
> test, and the two are allowed to disagree. When a label and the gate disagree, that disagreement is
> a finding about the gate, not an error in this rubric.

## The one question

> Could an adult use this on their own to manage **mood, stress, rumination, sleep, focus, motivation,
> or social anxiety** in daily life — either a **technique** it describes, or a **finding that directly
> supports** such a technique?

- **Yes → `keep`**
- **No → `reject`**

Judge the abstract on its own. Do not infer beyond what it states. When genuinely on the fence after
applying the rules below, default to **`keep`** (the gate is intentionally fail-open).

## `keep` — examples of what qualifies

- A self-applicable technique for everyday self-regulation: cognitive reappraisal, paced/slow
  breathing, behavioral activation, stimulus control / sleep hygiene, attention or focus training,
  brief mindfulness, worry postponement, self-compassion exercises.
- A finding that **directly supports** such a technique (e.g. "reappraisal reduced rumination"), even
  if it doesn't hand you a step-by-step protocol.
- Works in a clinical or lab sample but the **mechanism is self-applicable** by a non-patient adult.

## `reject` — categories that do not qualify

1. **Sports / athletic-performance** — training to run faster, jump higher, lift more; ergogenic aids.
2. **Clinical treatment protocols** requiring a clinician — drug dosing/pharmacotherapy, brain
   stimulation (TMS/tDCS/ECT), surgery, supervised titration, inpatient programs.
3. **Child / parenting programs** — interventions delivered to or through parents/children, school
   programs. (An adult self-regulation technique merely *studied* in young adults is not this.)
4. **Epidemiology with no actionable takeaway** — prevalence / incidence / cross-sectional association
   studies that describe a population but offer the reader nothing to *do*.

## Edge calls (write the reason in review notes)

- **Technique studied as a clinical treatment but self-applicable in principle** → `keep` (judge the
  mechanism, not the trial's setting).
- **A drug or device study that also reports a behavioral mechanism** → `reject` if the actionable
  content is the medical intervention; `keep` only if the self-applicable mechanism stands alone.
- **A correlational finding that implies a technique but tests none** → `reject` if it's pure
  epidemiology with no takeaway; `keep` if it directly motivates a specific self-applicable action.

## How this file is used (slice 4)

1. Harvest the uncorrected dataset: `pnpm -F @wabi/research eval:bootstrap` (writes
   `gate.dataset.jsonl` with `reviewed: false`, `metadata.modelLabel` = the gate's verdict).
2. **Correction pass (human):** for each row, label `expectedOutput` against THIS rubric, flipping it
   where the gate was wrong, and set `metadata.reviewed: true`. Preserve `metadata.modelLabel`.
3. Seed + run the baseline: `eval:seed` then `eval:gate`. Record accuracy, reject-precision,
   reject-recall, flip-rate, empty-reply-rate, and the count of rows where `modelLabel` ≠ corrected
   `expectedOutput` — the first cheap read on how wrong the current gate is.
