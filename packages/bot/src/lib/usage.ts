/**
 * Drop the token counts the provider didn't return, yielding undefined when none remain — so callers
 * record usage as ABSENT rather than as zero (a real 0 is kept; a missing field is omitted).
 *
 * The output key names are caller-chosen because two shapes need the same filter: CoachGeneration uses
 * `inputTokens`/`outputTokens`, while Langfuse's ingestion usage block uses `input`/`output`. One
 * filter, two key maps — so a future third count is added in exactly one place.
 */
export function compactUsage(
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
  keys: { input: string; output: string },
): Record<string, number> | undefined {
  if (!usage) return undefined;
  const out: Record<string, number> = {};
  if (typeof usage.inputTokens === 'number') out[keys.input] = usage.inputTokens;
  if (typeof usage.outputTokens === 'number') out[keys.output] = usage.outputTokens;
  return Object.keys(out).length ? out : undefined;
}
