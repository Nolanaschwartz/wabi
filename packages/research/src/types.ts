export type SourceKind = 'pubmed' | 'medrxiv' | 'psyarxiv';

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
  evidence: string;
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
