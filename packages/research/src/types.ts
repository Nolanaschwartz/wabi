export type SourceKind = 'pubmed' | 'medrxiv' | 'psyarxiv';

/** Structured evidence tier, set from the source's nature (never the model's claim). Ordered best to
 * weakest; drives the per-tier judge floor + cap (slice 05) and future retrieval re-ranking. */
export type EvidenceTier = 'meta-analysis' | 'systematic-review' | 'rct' | 'observational' | 'preprint';

export interface Paper {
  sourceId: string;     // "PMID:12345" | "doi:10.1101/..." | "osf:<guid>"
  sourceKind: SourceKind;
  title: string;
  abstract: string;
  url: string;
  pubTypes: string[];   // [] for medRxiv
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
}

export interface Bounds {
  maxTopicsPerRun: number;
  maxPapersPerTopic: number;
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
