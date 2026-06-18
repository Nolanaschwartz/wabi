import { Paper, EvidenceTier } from '../types';

const HIGH_TIER = ['Meta-Analysis', 'Systematic Review', 'Randomized Controlled Trial'];

// Pub-type label (PubMed vocabulary) -> structured tier. Anything peer-reviewed but unlisted is
// 'observational'; preprints are handled before this map is consulted.
const TIER_MAP: Record<string, EvidenceTier> = {
  'Meta-Analysis': 'meta-analysis',
  'Systematic Review': 'systematic-review',
  'Randomized Controlled Trial': 'rct',
};

/** Strip a ```json … ``` (or bare ``` … ```) fence some models wrap JSON in, so JSON.parse sees the
 * object. Returns the inner content trimmed, or the input unchanged when there is no fence. */
export function stripFences(s: string): string {
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (m ? m[1] : s).trim();
}

/** Evidence tag is set from the source's nature, never the model's self-claim (ADR-0012). */
export function evidenceTag(paper: Paper): string {
  if (paper.isPreprint) return 'preprint: not peer-reviewed';
  const tier = paper.pubTypes.find((t) => HIGH_TIER.includes(t));
  return tier ? `peer-reviewed: ${tier}` : 'peer-reviewed: observational';
}

/** Structured counterpart to {@link evidenceTag}: same source-derived signal, typed for policy. */
export function evidenceTier(paper: Paper): EvidenceTier {
  if (paper.isPreprint) return 'preprint';
  const tier = paper.pubTypes.map((t) => TIER_MAP[t]).find(Boolean);
  return tier ?? 'observational';
}
