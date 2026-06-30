/**
 * Personalization vocabularies — the single source of the Improvement Area and Interest
 * controlled vocabularies (CONTEXT.md: Personalization / Improvement Area / Interests).
 *
 * Shared by three callers so they can never drift: the web Onboarding form (labels), the
 * coach prompt (what the AI Coach reads about the person), and cold-start Strategy retrieval
 * (Improvement Area phrases seed the query when a Conversation has no context yet).
 *
 * Improvement Areas carry a natural-language *phrase* — used both to bias retrieval and to
 * render the coach prompt. Interests carry a display *label* only — read by the coach for
 * rapport, never fed to retrieval (ADR-0029: profile-shaped input is read directly, never
 * derived through Mem0).
 */

/** Improvement Area slug → query phrase. Order is the canonical display order. */
export const IMPROVEMENT_AREAS = {
  tilt: 'managing tilt and frustration while gaming',
  focus: 'improving focus and concentration',
  sleep: 'better sleep and rest',
  'social-connection': 'building social connection and reducing loneliness',
  burnout: 'recovering from burnout',
  motivation: 'finding motivation',
  'screen-time-balance': 'balancing screen time and other parts of life',
  confidence: 'building confidence',
  stress: 'managing stress',
} as const;

/** Interest slug → display label. Order is the canonical display order. */
export const INTERESTS = {
  fps: 'FPS',
  moba: 'MOBA',
  rpg: 'RPG',
  'ranked-grind': 'Ranked grind',
  streaming: 'Streaming',
  speedrunning: 'Speedrunning',
  music: 'Music',
  fitness: 'Fitness',
  'co-op-with-friends': 'Co-op with friends',
  'single-player-story': 'Single-player story',
} as const;

export type ImprovementAreaSlug = keyof typeof IMPROVEMENT_AREAS;
export type InterestSlug = keyof typeof INTERESTS;

/** Map known Improvement Area slugs to their query phrases; unknown slugs are dropped. */
export function expandAreas(slugs: string[]): string[] {
  return slugs.filter(isImprovementArea).map((s) => IMPROVEMENT_AREAS[s]);
}

/** Map known Interest slugs to their display labels; unknown slugs are dropped. */
export function interestLabels(slugs: string[]): string[] {
  return slugs.filter(isInterest).map((s) => INTERESTS[s]);
}

/**
 * True when the slug is a known Improvement Area — the validation seam onboarding uses.
 * Uses an own-property check, NOT `in`: `in` matches inherited Object.prototype keys
 * (`constructor`, `__proto__`, `toString`), which would let those non-slugs pass validation
 * and pollute the coach prompt + retrieval query.
 */
export function isImprovementArea(slug: string): slug is ImprovementAreaSlug {
  return Object.prototype.hasOwnProperty.call(IMPROVEMENT_AREAS, slug);
}

/** True when the slug is a known Interest. Own-property check (see {@link isImprovementArea}). */
export function isInterest(slug: string): slug is InterestSlug {
  return Object.prototype.hasOwnProperty.call(INTERESTS, slug);
}
