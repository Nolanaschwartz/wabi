import { Bounds, Candidate, RunSummary } from './types';
import { loadBounds } from './config';
import { SEED_TOPICS } from './seed-topics';
import { PubMedTool } from './sources/pubmed';
import { MedrxivTool } from './sources/medrxiv';
import { relevanceGate } from './agent/relevance-gate';
import { extract } from './agent/extract';
import { isDuplicateInRun } from './agent/dedup';
import { ResearchAgent } from './agent/research-agent';
import { BotClient, SubmitOutcome } from './bot-client';
import { Logger, noopLogger, defaultLogger } from './util/logger';
import { loadDotenv } from './util/load-env';
import { getProvider, ProviderRole } from '@wabi/shared';

/** Warn loudly when an LLM role resolved to the OpenAI default with no key — that 401s on every
 * call and the failure is otherwise silent (gate fails open, extract returns null, tokens=0). */
function checkProviders(log: Logger): void {
  for (const role of ['research', 'research-triage'] as ProviderRole[]) {
    const cfg = getProvider(role);
    if (cfg.baseUrl.includes('api.openai.com') && !cfg.apiKey) {
      log.info('WARNING: provider unconfigured — LLM calls will 401 (no candidates will be produced)', {
        role, baseUrl: cfg.baseUrl, hint: role === 'research' ? 'set RESEARCH_*' : 'set RESEARCH_TRIAGE_* or CLASSIFIER_*',
      });
    }
  }
}

export interface RunDeps {
  topics: string[];
  bounds: Bounds;
  runAgent: (topic: string) => Promise<{ candidates: Candidate[]; summary: Partial<RunSummary>; tokens: number }>;
  submit: (candidate: Candidate) => Promise<SubmitOutcome>;
  /** Injectable clock for deadline enforcement; defaults to Date.now. */
  now?: () => number;
  /** Optional progress logger; defaults to a no-op so tests stay silent. */
  log?: Logger;
}

export interface RunResult { submitted: number; deduped: number; rejected: number; errors: number; collected: number; stopReason: string }

/** Pure run core: iterate topics under the run budget, submit collected candidates, tally outcomes. */
export async function runResearch(deps: RunDeps): Promise<RunResult> {
  const result: RunResult = { submitted: 0, deduped: 0, rejected: 0, errors: 0, collected: 0, stopReason: 'exhausted' };
  const log = deps.log ?? noopLogger;
  const topics = deps.topics.slice(0, deps.bounds.maxTopicsPerRun);
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + deps.bounds.runTimeoutMs;
  log.info('run start', { topics: topics.length, maxDraftsPerRun: deps.bounds.maxDraftsPerRun });

  for (const topic of topics) {
    if (now() >= deadline) { result.stopReason = 'runTimeout'; log.info('run stop', { reason: 'runTimeout' }); break; }
    if (result.collected >= deps.bounds.maxDraftsPerRun) { result.stopReason = 'maxDraftsPerRun'; log.info('run stop', { reason: 'maxDraftsPerRun' }); break; }
    const { candidates } = await deps.runAgent(topic);
    for (const candidate of candidates) {
      if (result.collected >= deps.bounds.maxDraftsPerRun) break;
      result.collected++;
      const outcome = await deps.submit(candidate);
      if (outcome === 'submitted') result.submitted++;
      else if (outcome === 'deduped') result.deduped++;
      else if (outcome === 'rejected') result.rejected++;
      else result.errors++;
      log.info('submit', { title: candidate.title, outcome });
    }
  }
  log.info('run done', { ...result });
  return result;
}

/* istanbul ignore next — real wiring, exercised manually / in production, not unit-tested. */
async function main(): Promise<void> {
  // The worker has no Nest ConfigModule — load the root .env ourselves, BEFORE resolving any
  // provider/bounds config, or every LLM call 401s on the OpenAI default (tokens=0 everywhere).
  const envPath = loadDotenv();
  const log = defaultLogger();
  log.info('env loaded', { path: envPath ?? '(none found)' });
  checkProviders(log);

  const bounds = loadBounds();
  const botUrl = process.env.BOT_BASE_URL || 'http://localhost:3001';
  const secret = process.env.ADMIN_API_SECRET || '';
  const client = new BotClient({ baseUrl: botUrl, secret });
  const pubmed = new PubMedTool({ apiKey: process.env.NCBI_API_KEY });
  const medrxiv = new MedrxivTool();

  const topicArg = process.argv.indexOf('--topic');
  const topics = topicArg !== -1 ? [process.argv[topicArg + 1]] : SEED_TOPICS;

  let tokensUsed = 0;
  let topicsRun = 0;
  const summaryTotals: Record<string, number> = {};

  const result = await runResearch({
    topics,
    bounds,
    log,
    submit: (c) => client.submit(c),
    runAgent: async (topic) => {
      const agent = new ResearchAgent(
        { pubmed, medrxiv, seen: (id) => client.seen(id), gate: relevanceGate, extract, dedup: isDuplicateInRun },
        bounds,
        log,
      );
      const out = await agent.run(topic);
      topicsRun++;
      tokensUsed += agent.tokens;
      for (const [key, value] of Object.entries(out.summary)) {
        if (typeof value === 'number') {
          summaryTotals[key] = (summaryTotals[key] ?? 0) + value;
        }
      }
      return { candidates: out.candidates, summary: out.summary, tokens: agent.tokens };
    },
  });

  // eslint-disable-next-line no-console
  console.log('[research] run summary', { ...summaryTotals, ...result, tokensUsed, topicsRun });
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main();
}
