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

export interface RunDeps {
  topics: string[];
  bounds: Bounds;
  runAgent: (topic: string) => Promise<{ candidates: Candidate[]; summary: Partial<RunSummary>; tokens: number }>;
  submit: (candidate: Candidate) => Promise<SubmitOutcome>;
  /** Injectable clock for deadline enforcement; defaults to Date.now. */
  now?: () => number;
}

export interface RunResult { submitted: number; deduped: number; errors: number; collected: number; stopReason: string }

/** Pure run core: iterate topics under the run budget, submit collected candidates, tally outcomes. */
export async function runResearch(deps: RunDeps): Promise<RunResult> {
  const result: RunResult = { submitted: 0, deduped: 0, errors: 0, collected: 0, stopReason: 'exhausted' };
  const topics = deps.topics.slice(0, deps.bounds.maxTopicsPerRun);
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + deps.bounds.runTimeoutMs;

  for (const topic of topics) {
    if (now() >= deadline) { result.stopReason = 'runTimeout'; break; }
    if (result.collected >= deps.bounds.maxDraftsPerRun) { result.stopReason = 'maxDraftsPerRun'; break; }
    const { candidates } = await deps.runAgent(topic);
    for (const candidate of candidates) {
      if (result.collected >= deps.bounds.maxDraftsPerRun) break;
      result.collected++;
      const outcome = await deps.submit(candidate);
      if (outcome === 'submitted') result.submitted++;
      else if (outcome === 'deduped') result.deduped++;
      else result.errors++;
    }
  }
  return result;
}

/* istanbul ignore next — real wiring, exercised manually / in production, not unit-tested. */
async function main(): Promise<void> {
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
    submit: (c) => client.submit(c),
    runAgent: async (topic) => {
      const agent = new ResearchAgent(
        { pubmed, medrxiv, seen: (id) => client.seen(id), gate: relevanceGate, extract, dedup: isDuplicateInRun },
        bounds,
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
