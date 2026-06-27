import { Paper, SourceKind } from '../types';

/**
 * A uniform evidence source (ADR-0036). Each adapter owns its own id keyspace (`PMID:`/`doi:`/`osf:`),
 * so the agent never strips a prefix or routes full-text by `sourceKind` — it dispatches every call to
 * the adapter registered for `paper.sourceKind` and the adapter handles its own ids.
 */
export interface Source {
  readonly kind: SourceKind;

  /**
   * Candidate papers for a topic. Preprint sources (medRxiv/PsyArXiv) return COMPLETE papers (their
   * list endpoints include the abstract). PubMed returns THIN papers — id + kind + url, empty
   * title/abstract — because its list endpoint yields ids only; call {@link hydrate} before the gate.
   */
  search(query: string, limit: number): Promise<Paper[]>;

  /**
   * Fill a thin paper's title/abstract/pubTypes. Identity for sources whose `search` already returns
   * complete papers. The agent runs it AFTER the seen-check, so PubMed never spends a rate-limited
   * fetch on a paper already in the library (the lazy seen-skip, preserved — ADR-0036).
   */
  hydrate(paper: Paper): Promise<Paper>;

  /** Open-access full text for the paper, or null to fall back to the abstract. Reads `paper.sourceId`. */
  fullText(paper: Paper): Promise<string | null>;

  /**
   * Optional citation-graph discovery: thin papers related to this one (same keyspace as `search`).
   * Only sources with a citation graph (PubMed) implement it; the agent feature-detects (`src.expand`)
   * and gates expansion by `maxDiscoverySteps`.
   */
  expand?(paper: Paper): Promise<Paper[]>;

  /**
   * Optional batch title lookup for discovery: given source ids (same keyspace as `search`), return
   * {id, title} in ONE call. Only sources with `expand` need it (the discovery selector reads titles
   * before chasing). PubMed: one esummary call for comma-joined PMIDs.
   */
  summarize?(ids: string[]): Promise<{ id: string; title: string }[]>;
}
