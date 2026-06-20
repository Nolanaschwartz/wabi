import { SourceKind } from '../../types';
import { Concepts } from './concepts';
import { pubmedQuery } from './pubmed-adapter';
import { epmcQuery } from './epmc-adapter';

/**
 * Render the per-topic {@link Concepts} into the query string a given source's `search` expects. PubMed
 * gets a real boolean term (no implicit-AND collapse); sources still on the windowed local term-match
 * get the raw topic for now (the topical EPMC/OSF adapters replace those arms as those slices land).
 * Falls back to the raw topic if the adapter produced nothing.
 */
export function queryForKind(kind: SourceKind, topic: string, concepts: Concepts): string {
  switch (kind) {
    case 'pubmed':
      return pubmedQuery(concepts) || topic;
    case 'europepmc':
      return epmcQuery(concepts) || topic;
    default:
      return topic;
  }
}
