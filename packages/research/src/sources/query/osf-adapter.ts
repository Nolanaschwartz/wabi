import { Concepts } from './concepts';

/** Max distinct phrases to search per topic — each becomes one OSF request (OSF has no `filter[q]` and
 * AND-s multiple `filter[]`, so OR-ing synonyms means separate requests). Bounds the per-topic calls. */
const MAX_PHRASES = 5;

/**
 * Render concepts into the OSF topical-search payload: the core mechanism phrases (capped), newline-
 * joined. OSF's `/v2/preprints/` has no `filter[q]` (verified — returns HTTP 400); the source instead
 * issues one `filter[description][icontains]=<phrase>` request per phrase and merges. Returns '' for
 * empty concepts so the caller can fall back to the raw topic.
 */
export function osfQuery(c: Concepts): string {
  return c.core.slice(0, MAX_PHRASES).join('\n');
}
