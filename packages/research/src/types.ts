export type SourceKind = 'pubmed' | 'psyarxiv' | 'europepmc';

/** Structured evidence tier, set from the source's nature (never the model's claim). Ordered best to
 * weakest; drives the per-tier judge floor + cap (slice 05) and future retrieval re-ranking. */
export type EvidenceTier = 'meta-analysis' | 'systematic-review' | 'rct' | 'observational' | 'preprint';

/** Extraction lens — the angle a technique was surfaced through. Carried as in-flight provenance on a
 * Candidate; slice 04 collapses agreeing lenses into a persisted lenses[] + lensAgreement count. */
export type Lens = 'behavioral' | 'cognitive' | 'social' | 'environmental' | 'physiological';

export interface Paper {
  sourceId: string;     // "PMID:12345" | "doi:10.1101/..." | "osf:<guid>"
  sourceKind: SourceKind;
  title: string;
  abstract: string;
  url: string;
  pubTypes: string[];   // [] for preprints (Europe PMC / PsyArXiv)
  isPreprint: boolean;
}

export interface Candidate {
  title: string;
  technique: string;
  sourceText: string;   // verbatim substring of the source body/abstract
  evidence: string;        // human-readable display tag (coach prompt)
  evidenceTier: EvidenceTier; // structured tier (policy + retrieval)
  sourceUrl: string;
  source: string;       // descriptive label -> StrategyDraft.source
  sourceId: string;
  sourceKind: SourceKind;
  trustLevel: 'research-agent';
  lens?: Lens;             // in-flight provenance: which single lens surfaced this technique
  lenses?: Lens[];         // after within-paper merge: every lens that surfaced it
  lensAgreement?: number;  // distinct-lens count (robustness signal)
  confidence?: number;     // judge score 0..1 (slice 05); -> Qdrant effectivenessScore
  rationale?: string;      // judge's one-line justification (reviewer audit)
}

export interface Bounds {
  maxTopicsPerRun: number;
  maxPapersPerTopic: number;
  /** How many candidates to FETCH per source per topic (search breadth), decoupled from how many to
   * PROCESS (`maxPapersPerTopic`). Server-ranked by relevance; the gate + processing cap pick from them. */
  searchLimit: number;
  maxDiscoverySteps: number;
  maxDraftsPerTopic: number;
  maxDraftsPerRun: number;
  agentTimeoutMs: number;
  runTimeoutMs: number;
  tokenBudget: number;
}

export interface RunSummary {
  searched: number;
  seenSkipped: number;
  gatedOut: number;
  extracted: number;
  inRunDeduped: number;
  collected: number;
  submitted: number;
  libDeduped: number;
  errors: number;
  stopReason: string;
}
