import { createOpenAI } from '@ai-sdk/openai';
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
}

export interface RunResult { submitted: number; deduped: number; errors: number; collected: number }

/** Pure run core: iterate topics under the run budget, submit collected candidates, tally outcomes. */
export async function runResearch(deps: RunDeps): Promise<RunResult> {
  const result: RunResult = { submitted: 0, deduped: 0, errors: 0, collected: 0 };
  const topics = deps.topics.slice(0, deps.bounds.maxTopicsPerRun);

  for (const topic of topics) {
    if (result.collected >= deps.bounds.maxDraftsPerRun) break;
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
      return { candidates: out.candidates, summary: out.summary, tokens: agent.tokens };
    },
  });

  // eslint-disable-next-line no-console
  console.log('[research] run summary', result);
}

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main();
}

export { createOpenAI };
