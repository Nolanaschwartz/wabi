/**
 * Harvest a balanced ~60-item gate-eval dataset from LIVE sources, replacing the hand-written seed
 * rows (ADR-0040, Phase 1 slice 3). Reproducible from one command — the topic and probe lists are
 * fixed in this file.
 *
 *   pnpm -F @wabi/research eval:bootstrap
 *
 * Two prongs:
 *   - Positives follow the REAL production search path (topicToConcepts → queryForKind → search →
 *     hydrate) across every source, so they match the distribution the gate actually sees.
 *   - Negatives use fixed keyword probes targeting the four reject categories, deliberately reaching
 *     OUTSIDE the production distribution.
 *
 * Runs the CURRENT gate over every abstract and records its verdict as metadata.modelLabel. The output
 * is UNCORRECTED (reviewed: false) — the human correction pass + intent rubric are slice 4. Writes only
 * the local JSONL; submits nothing, touches no production data. Sources self-rate-limit internally.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { PubMedTool } from '../src/sources/pubmed';
import { EuropePmcSource } from '../src/sources/europepmc';
import { createPsyArxivSource } from '../src/sources/psyarxiv';
import { topicToConcepts } from '../src/sources/query/concepts';
import { queryForKind } from '../src/sources/query/for-kind';
import { relevanceGate } from '../src/agent/relevance-gate';
import { Source } from '../src/sources/source';
import { Paper, SourceKind } from '../src/types';
import { defaultLogger } from '../src/util/logger';
import { loadDotenv } from '../src/util/load-env';

const OUT = join(__dirname, '../evals/gate.dataset.jsonl');

// Fixed lists → the harvest reproduces the same structure on every run.
const POSITIVE_TOPICS = [
  'cognitive reappraisal for stress and rumination',
  'paced breathing for anxiety',
  'self-guided sleep hygiene for insomnia',
];
const NEGATIVE_PROBES: { category: string; query: string }[] = [
  { category: 'sports-performance', query: 'sprint training athletic performance' },
  { category: 'clinical-treatment', query: 'antidepressant pharmacotherapy randomized controlled trial' },
  { category: 'child-parenting', query: 'parenting program child behavior intervention' },
  { category: 'epidemiology', query: 'prevalence epidemiology cross-sectional survey' },
];
const POS_PER_SOURCE = 4; // per topic per source
const NEG_PER_PROBE = 7; // per probe (PubMed only)

interface Row {
  input: { abstract: string };
  expectedOutput: 'keep' | 'reject';
  metadata: { source: SourceKind; id: string; topic: string; bucket: 'positive' | 'negative'; modelLabel: 'keep' | 'reject'; reviewed: false };
}

const log = defaultLogger();

/** Search → hydrate, dropping anything without an abstract. One source failure never kills the run. */
async function harvest(src: Source, query: string, limit: number): Promise<Paper[]> {
  let thin: Paper[];
  try {
    thin = await src.search(query, limit);
  } catch (e) {
    log.info(`[bootstrap] ${src.kind} search failed: ${(e as Error).message}`);
    return [];
  }
  const out: Paper[] = [];
  for (const p of thin) {
    try {
      const h = await src.hydrate(p);
      if (h.abstract?.trim()) out.push(h);
    } catch (e) {
      log.info(`[bootstrap] ${src.kind} hydrate ${p.sourceId} failed: ${(e as Error).message}`);
    }
  }
  return out;
}

/** Gate the abstract and build a row. expectedOutput starts as the model's verdict (uncorrected). */
async function toRow(p: Paper, topic: string, bucket: 'positive' | 'negative'): Promise<Row> {
  const r = await relevanceGate(p.abstract);
  const modelLabel = r.keep ? 'keep' : 'reject';
  return {
    input: { abstract: p.abstract },
    expectedOutput: modelLabel,
    metadata: { source: p.sourceKind, id: p.sourceId, topic, bucket, modelLabel, reviewed: false },
  };
}

async function main(): Promise<void> {
  console.error(`[bootstrap] env loaded from ${loadDotenv() ?? '(none found)'}`);

  // Same wiring as the production runner, keys read lazily from the environment.
  const sources: Source[] = [
    new PubMedTool({ apiKey: process.env.NCBI_API_KEY }),
    new EuropePmcSource({ log }),
    createPsyArxivSource({ token: process.env.OSF_TOKEN, log }),
  ];
  const pubmed = sources[0];

  const rows: Row[] = [];
  const seen = new Set<string>(); // dedup by sourceId across topics/sources

  const add = async (papers: Paper[], topic: string, bucket: 'positive' | 'negative'): Promise<void> => {
    for (const p of papers) {
      if (seen.has(p.sourceId)) continue;
      seen.add(p.sourceId);
      rows.push(await toRow(p, topic, bucket));
    }
  };

  // Positives — real production path: concepts → per-source query → search → hydrate.
  for (const topic of POSITIVE_TOPICS) {
    const concepts = await topicToConcepts(topic);
    for (const src of sources) {
      const q = queryForKind(src.kind, topic, concepts);
      const papers = await harvest(src, q, POS_PER_SOURCE);
      await add(papers, topic, 'positive');
      log.info(`[bootstrap] positive "${topic}" via ${src.kind}: +${papers.length}`);
    }
  }

  // Negatives — fixed keyword probes (PubMed), reaching outside the production distribution.
  for (const probe of NEGATIVE_PROBES) {
    const papers = await harvest(pubmed, probe.query, NEG_PER_PROBE);
    await add(papers, probe.category, 'negative');
    log.info(`[bootstrap] negative "${probe.category}": +${papers.length}`);
  }

  writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const pos = rows.filter((r) => r.metadata.bucket === 'positive').length;
  const neg = rows.length - pos;
  console.log(`\nwrote ${rows.length} items to ${OUT}  (positive ${pos} / negative ${neg})`);
  console.log('UNCORRECTED (reviewed: false) — run the slice-4 correction pass before trusting labels.');
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
