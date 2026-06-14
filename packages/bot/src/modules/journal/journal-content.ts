/**
 * Inline journal-content extraction — the one rule that decides whether a journal-intent DM is a
 * complete one-turn entry ("journal: had a rough night…") or a bare intent that needs the two-turn
 * conversational prompt ("i want to journal"). Pure and dependency-free so the boundary is exhaustively
 * testable: the router owns "is this journal?", this owns "did they already write the entry?".
 *
 * Rule: strip a leading journal trigger phrase if present, then require the remainder to clear a
 * substantive-content floor (enough words AND characters to be a real entry, not a leftover preposition
 * like "about my day"). Below the floor ⇒ bare intent ⇒ null. With no trigger to strip, the whole
 * message is taken as the entry (the router already decided intent=journal).
 */

// Leading phrases that announce the intent without being part of the entry. Ordered longest-first so a
// natural-language lead-in is consumed whole before the bare "journal" token can match a prefix of it.
const TRIGGER_LEAD_INS: RegExp[] = [
  /^\s*(i\s+(want|wanna|need|would like|'?d like)\s+to\s+journal)\b/i,
  /^\s*(let'?s|let me|lets|can i|could i|i'?ll|i'?d like to|time to)\s+journal\b/i,
  /^\s*(write|add|make|log|start)\s+(a\s+)?journal(\s+(entry|note))?\b/i,
  /^\s*journal(ing)?\b/i,
  /^\s*dear diary\b/i,
];

/** Minimum substantive content after stripping the lead-in, so a thin remainder is treated as bare. */
const MIN_CONTENT_WORDS = 3;
const MIN_CONTENT_CHARS = 12;

export function extractInlineJournalContent(batch: string): string | null {
  const raw = batch.trim();
  if (!raw) return null;

  let remainder = raw;
  for (const lead of TRIGGER_LEAD_INS) {
    if (lead.test(remainder)) {
      remainder = remainder.replace(lead, '');
      break;
    }
  }

  // Drop punctuation/connectives the lead-in left dangling (": ", " - ", "that ", "about how ...").
  remainder = remainder.replace(/^[\s:,.\-—]+/, '').trim();

  const words = remainder.split(/\s+/).filter(Boolean);
  if (words.length < MIN_CONTENT_WORDS || remainder.length < MIN_CONTENT_CHARS) return null;

  return remainder;
}
