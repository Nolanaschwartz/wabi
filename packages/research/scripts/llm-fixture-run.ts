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
import { extract } from '../src/agent/extract';
import { isDuplicateInRun } from '../src/agent/dedup';
import { PubMedTool } from '../src/sources/pubmed';
import { MedrxivTool } from '../src/sources/medrxiv';
import { loadBounds } from '../src/config';

const ROOT_ENV = join(__dirname, '../../../.env');
const FIX = join(__dirname, '../src/sources/__tests__/fixtures');

/** Minimal .env loader (no dotenv dep). Does not override vars already in process.env. */
function loadEnv(path: string): void {
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.error(`[harness] could not read ${path}`);
    return;
  }
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (process.env[k] === undefined) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
}

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
  loadEnv(ROOT_ENV);

  // The `research` role (extract) has NO fallback in getProvider — unset RESEARCH_* => OpenAI + empty
  // key => 401 (blind spot #2). For this local test, point it at the classifier tier if unset.
  const defaulted: string[] = [];
  for (const [r, c] of [
    ['RESEARCH_BASE_URL', 'CLASSIFIER_BASE_URL'],
    ['RESEARCH_MODEL', 'CLASSIFIER_MODEL'],
    ['RESEARCH_API_KEY', 'CLASSIFIER_API_KEY'],
  ] as const) {
    if (process.env[r] === undefined && process.env[c] !== undefined) {
      process.env[r] = process.env[c];
      defaulted.push(r);
    }
  }
  if (defaulted.length) {
    console.warn(`[harness] ${defaulted.join(', ')} unset in .env -> using CLASSIFIER_* for this run (see blind spot #2)`);
  }

  const topic = process.argv[2] || 'anxiety';
  const bounds = loadBounds();

  const fetchFn = fixtureFetch();
  const pubmed = new PubMedTool({ fetchFn, minIntervalMs: 0 });
  const medrxiv = new MedrxivTool({ fetchFn, minIntervalMs: 0, windowDays: 30, now: () => new Date('2024-01-06') });

  console.log(`[harness] topic="${topic}"  research=${process.env.RESEARCH_BASE_URL} (${process.env.RESEARCH_MODEL})`);
  console.log(`[harness] triage=${process.env.RESEARCH_TRIAGE_BASE_URL || process.env.CLASSIFIER_BASE_URL} (${process.env.RESEARCH_TRIAGE_MODEL || process.env.CLASSIFIER_MODEL})`);

  const agent = new ResearchAgent(
    { pubmed, medrxiv, seen: async () => false, gate: relevanceGate, extract, dedup: isDuplicateInRun },
    bounds,
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
