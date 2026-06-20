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
import { makeResearchGenerate } from '../src/agent/research-generate';
import { Source } from '../src/sources/source';
import { Paper } from '../src/types';
import { defaultLogger } from '../src/util/logger';
import { loadDotenv } from '../src/util/load-env';
import { Bucket, DatasetRow } from './eval-env';

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

const log = defaultLogger();

// ponytail: search/hydrate/gate run strictly serially. Deliberate — each source self-rate-limits
// (RateLimiter), so parallelism would just queue behind the same limiter, and the gate hits a single
// local endpoint. This is a one-shot dev harvest, not a hot path; serial keeps it simple and polite.

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
async function toRow(p: Paper, topic: string, bucket: Bucket): Promise<DatasetRow> {
  // Topic-aware gate; bootstrap only needs the keep/reject verdict, so a no-tracer `gen` (runs the
  // model, emits no span) is enough.
  const r = await relevanceGate(makeResearchGenerate(), p.abstract, topic);
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

  const rows: DatasetRow[] = [];
  // Dedup on the SAME `<source>:<id>` key the seed upserts on, so the two layers agree on uniqueness
  // (a bare sourceId could collide across sources).
  const seen = new Set<string>();
  const key = (p: Paper): string => `${p.sourceKind}:${p.sourceId}`;

  const add = async (papers: Paper[], topic: string, bucket: Bucket): Promise<void> => {
    for (const p of papers) {
      if (seen.has(key(p))) continue;
      seen.add(key(p));
      rows.push(await toRow(p, topic, bucket));
    }
  };

  // Negatives FIRST: a reject-category paper (e.g. a pharmacotherapy trial) can surface in a positive
  // topic search too; claiming it as a negative here keeps its bucket correct, and the positive pass
  // then skips it. Negative probes are narrow reject-category keywords, so they won't wrongly claim a
  // genuine self-help positive.
  for (const probe of NEGATIVE_PROBES) {
    const papers = await harvest(pubmed, probe.query, NEG_PER_PROBE);
    await add(papers, probe.category, 'negative');
    log.info(`[bootstrap] negative "${probe.category}": +${papers.length}`);
  }

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

  // Refuse to clobber the checked-in dataset with a failed harvest. Every source failure is swallowed
  // to []; if the network/keys are down, `rows` is empty and writing would silently destroy the
  // curated (possibly human-reviewed) seed. A too-small harvest is almost certainly a partial outage,
  // not a real dataset — bail and leave the existing file untouched.
  const MIN_ROWS = 10;
  if (rows.length < MIN_ROWS) {
    console.error(
      `\nharvest produced only ${rows.length} row(s) (< ${MIN_ROWS}) — likely a source/provider outage. ` +
        `Refusing to overwrite ${OUT}. Fix connectivity/keys and re-run.`,
    );
    process.exitCode = 1;
    return;
  }

  writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const pos = rows.filter((r) => r.metadata.bucket === 'positive').length;
  const neg = rows.length - pos;
  console.log(`\nwrote ${rows.length} items to ${OUT}  (positive ${pos} / negative ${neg})`);
  console.log('UNCORRECTED (reviewed: false) — run the slice-4 correction pass before trusting labels.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
