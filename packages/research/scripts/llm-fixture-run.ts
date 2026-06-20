/**
 * Drive the REAL research agent loop against captured fixtures, using the LOCAL LLMs in the root
 * .env — no live NCBI/medRxiv, no bot. This exercises the parts the fixture *specs* mock out:
 * the relevance gate, the extract step (real JSON parsing of a real model's output), and in-run
 * dedup — i.e. blind spots #1 (model output isn't clean JSON), #2 (provider config), #3 (full loop).
 *
 *   pnpm -F @wabi/research ts-node scripts/llm-fixture-run.ts [topic]
 *
 * Read-only: prints a run summary + the candidates the agent would submit. Submits nothing.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ResearchAgent } from '../src/agent/research-agent';
import { relevanceGate } from '../src/agent/relevance-gate';
import { extractWithLenses } from '../src/agent/extract-with-lenses';
import { mergeWithinPaper } from '../src/agent/merge-within-paper';
import { judgeCandidates } from '../src/agent/judge';
import { isDuplicateInRun } from '../src/agent/dedup';
import { topicToConcepts } from '../src/sources/query/concepts';
import { Source } from '../src/sources/source';
import { SourceKind } from '../src/types';
import { PubMedTool } from '../src/sources/pubmed';
import { loadBounds } from '../src/config';
import { defaultLogger } from '../src/util/logger';
import { loadDotenv } from '../src/util/load-env';
import { getProvider } from '@wabi/shared';

const FIX = join(__dirname, '../src/sources/__tests__/fixtures');

const read = (name: string): string => readFileSync(join(FIX, name), 'utf8');

/** A fetch that serves the captured PubMed/BioC/medRxiv fixtures by URL. */
function fixtureFetch(): typeof fetch {
  const fn = async (url: unknown): Promise<Response> => {
    const u = String(url);
    const file = u.includes('esearch.fcgi')
      ? 'esearch.json'
      : u.includes('esummary.fcgi')
        ? 'esummary.json'
        : u.includes('efetch.fcgi')
          ? 'efetch-abstract.txt'
          : u.includes('elink.fcgi')
            ? 'elink.json'
            : u.includes('BioC_json')
              ? 'bioc.json'
              : u.includes('api.medrxiv.org')
                ? 'medrxiv-details.json'
                : null;
    if (!file) throw new Error(`fixtureFetch: no fixture for ${u}`);
    const body = read(file);
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(body),
      text: async () => body,
    } as Response;
  };
  return fn as unknown as typeof fetch;
}

async function main(): Promise<void> {
  console.error(`[harness] env loaded from ${loadDotenv() ?? '(none found)'}`);

  // No manual provider wiring: getProvider falls research -> COACH and research-triage -> CLASSIFIER
  // when RESEARCH_* is unset, so this exercises the same resolution the real worker uses.
  const research = getProvider('research');
  const triage = getProvider('research-triage');

  const topic = process.argv[2] || 'anxiety';
  const bounds = loadBounds();

  const fetchFn = fixtureFetch();
  const pubmed = new PubMedTool({ fetchFn, minIntervalMs: 0 });

  console.log(`[harness] topic="${topic}"  research=${research.baseUrl} (${research.model})`);
  console.log(`[harness] triage=${triage.baseUrl} (${triage.model})`);

  // Show every step by default for the harness; override with RESEARCH_LOG_LEVEL.
  if (process.env.RESEARCH_LOG_LEVEL === undefined) process.env.RESEARCH_LOG_LEVEL = 'debug';
  // PubMed-only against fixtures (the preprint sources now query live EPMC/OSF, ADR-0039); ADR-0036 map.
  const sources = new Map<SourceKind, Source>([['pubmed', pubmed]]);
  const agent = new ResearchAgent(
    {
      sources,
      buildConcepts: topicToConcepts,
      seen: async () => false,
      markGated: async () => {},
      pipeline: {
        gate: relevanceGate,
        extract: extractWithLenses,
        merge: mergeWithinPaper,
        judge: judgeCandidates,
        dedup: isDuplicateInRun,
      },
    },
    bounds,
    defaultLogger(),
  );

  const started = Date.now();
  const out = await agent.run(topic);
  const ms = Date.now() - started;

  console.log('\n=== run summary ===');
  console.log({ ...out.summary, tokensUsed: agent.tokens, wallMs: ms });
  console.log(`\n=== ${out.candidates.length} candidate(s) the agent would submit ===`);
  for (const [i, c] of out.candidates.entries()) {
    console.log(`\n[${i + 1}] ${c.title}  (${c.evidence}, ${c.source})`);
    console.log(`    technique: ${c.technique}`);
    console.log(`    sourceText: ${c.sourceText.slice(0, 160)}${c.sourceText.length > 160 ? '…' : ''}`);
    console.log(`    verbatim-substring-of-body: enforced by extract()`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
