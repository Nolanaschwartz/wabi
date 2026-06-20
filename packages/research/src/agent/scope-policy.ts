/** Canonical definition of "self-administered, non-clinical practice" for the research worker
 * (ADR-0001/0003). The gate, extractor, and judge all import SCOPE_FRAGMENT so their scope wording
 * can never drift apart, and the worker runs `prescreen` before the gate LLM call to drop clearly
 * out-of-scope papers without spending a model call. */

/** Shared prompt fragment. Embed verbatim in any prompt that must enforce scope. */
export const SCOPE_FRAGMENT =
  `Scope: only self-administered, non-clinical everyday practices a person can do unaided — ` +
  `behavioral, cognitive, social, or environmental techniques for mood, stress, rumination, ` +
  `sleep, focus, motivation, or social anxiety. OUT of scope: anything requiring a supplement, ` +
  `vitamin, dosed nutrient, drug/medication, a clinician, or a device/procedure (brain ` +
  `stimulation, surgery); also athletic-performance, child/parenting programs, and epidemiology ` +
  `with no actionable takeaway.`;

// Clear out-of-scope signals only. Conservative by design (ADR-0021 fail-open mining): a hit is a
// confident reject; everything else passes through to the topic-aware gate, which arbitrates the
// genuinely ambiguous cases. ponytail: keyword list, upgrade path is the gate LLM that follows it.
const OUT_OF_SCOPE: RegExp[] = [
  /\bvitamin\s+[a-z0-9]/i,
  /\bsupplement(s|ation|ed|ing)?\b/i,
  /\bomega-?3\b/i,
  /\bprobiotic/i,
  /\bmelatonin\b/i,
  /\bcreatine\b/i,
  /\b\d+\s?mg\b/i,
  /\bmg\/(kg|day)\b/i,
  /\bdos(e|es|ed|age|ing)\b/i,
  /\bpharmacolog/i,
  /\b(ssri|antidepressant|medication|pharmacotherapy)\b/i,
  /\b(transcranial|tdcs|tms|rtms)\b/i,
  /\bsurg(ery|ical)\b/i,
];

/** Pure, no-LLM scope pre-screen. `true` = in scope (or ambiguous → keep); `false` = a clear
 * supplement/drug/clinical signal was found. */
export function prescreen(text: string): boolean {
  const t = text ?? '';
  return !OUT_OF_SCOPE.some((re) => re.test(t));
}
