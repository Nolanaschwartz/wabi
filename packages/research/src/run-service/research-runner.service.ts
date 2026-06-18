import { Injectable } from '@nestjs/common';
import { Bounds, Candidate, SourceKind } from '../types';
import { runResearch as defaultRunResearch, RunDeps, RunResult } from '../run';
import { BotClient, SubmitOutcome } from '../bot-client';
import { Source } from '../sources/source';
import { PubMedTool } from '../sources/pubmed';
import { MedrxivTool } from '../sources/medrxiv';
import { PsyArxivTool } from '../sources/psyarxiv';
import { relevanceGate } from '../agent/relevance-gate';
import { extractWithLenses } from '../agent/extract-with-lenses';
import { mergeWithinPaper } from '../agent/merge-within-paper';
import { judgeCandidates } from '../agent/judge';
import { isDuplicateInRun } from '../agent/dedup';
import { ResearchAgent } from '../agent/research-agent';
import { ResearchTracer } from '../agent/research-tracer';
import { Logger, noopLogger } from '../util/logger';

/** The runner's verdict for a single run: the pure {@link RunResult} counts plus the two totals the
 * core tracks OUTSIDE its result (`tokensUsed`, `topicsRun`). */
export interface RunnerResult extends RunResult {
  tokensUsed: number;
  topicsRun: number;
}

/** Inputs the runner needs to perform one run — both come from the DATABASE (the source of truth):
 * the eight bounds (mapped from the ResearchConfig singleton) and the enabled topic texts. */
export interface RunnerInput {
  bounds: Bounds;
  topics: string[];
}

/**
 * The seams that make the runner unit-testable without real network/LLM. Defaults wire the production
 * stack (PubMed/medRxiv tools, relevance gate, extract, in-run dedup, BotClient submit). A test
 * injects fakes (or jest.mocks the module) so no spec ever touches PubMed/medRxiv/the bot.
 */
export interface RunnerDeps {
  /** The pure run core. Injected so a unit test can supply a fake that returns known counts. */
  runFn?: (deps: RunDeps) => Promise<RunResult>;
  /**
   * Builds the per-run agent wiring + submit. Returns the two {@link RunDeps} closures the core
   * calls (`runAgent`/`submit`) and a `tokens()`/`topicsRun()` accessor pair so the runner can read
   * the totals the agent accrues OUTSIDE the result. Resolved lazily per run (reads env at call
   * time, never at import) so STRATEGY_API_URL/ADMIN_API_SECRET/NCBI_API_KEY are never frozen.
   */
  buildAgent?: (bounds: Bounds, log: Logger) => BuiltAgent;
  log?: Logger;
}

/** The per-run wiring `buildAgent` returns: the two {@link RunDeps} closures plus accessors for the
 * running totals the agent accrues OUTSIDE the result. `runAgent` returns the core's expected shape
 * (a `summary` the core ignores is carried for type-compatibility with {@link RunDeps}). */
interface BuiltAgent {
  runAgent: RunDeps['runAgent'];
  submitBatch: (candidates: Candidate[]) => Promise<SubmitOutcome[]>;
  tokens: () => number;
  topicsRun: () => number;
  /** Optional: flush any in-flight Langfuse ingestion once the run is done so the last spans aren't
   * lost when the worker is short-lived. Absent on the test seam (which traces nothing). */
  flushTracing?: () => Promise<void>;
}

/**
 * Resolve the candidate-ingest base URL lazily, per run. `STRATEGY_API_URL` is the configurable seam
 * (a future Strategy-API extraction is an env change, no code rework); it falls back to the bot's
 * base URL, then localhost. NEVER cache this — env is populated by ConfigModule after import (the
 * same lazy-getter rule the bot's provider resolution follows).
 */
function strategyApiUrl(): string {
  return process.env.STRATEGY_API_URL || process.env.BOT_BASE_URL || 'http://localhost:3001';
}

/**
 * Wraps the untouched `runResearch` core to produce a real run summary (ADR-0034, ADR-0012).
 *
 * `execute()` builds the production agent + submit wiring (PubMed/medRxiv → relevance gate → extract
 * → in-run dedup → BotClient.submit), runs the core over the DB-sourced topics under the DB-sourced
 * bounds, and returns the {@link RunResult} counts plus `tokensUsed`/`topicsRun`. Candidate ingest
 * ALWAYS goes HTTP → the bot's trust gate (the only path into `StrategyDraft`); the worker never
 * writes the strategy library directly.
 *
 * Built for injection: the heavy core and agent factory are seams (constructor deps), so a unit test
 * supplies fakes and asserts the count mapping without any network/LLM.
 */
@Injectable()
export class ResearchRunnerService {
  private readonly runFn: (deps: RunDeps) => Promise<RunResult>;
  private readonly buildAgent: NonNullable<RunnerDeps['buildAgent']>;
  private readonly log: Logger;

  constructor(deps: RunnerDeps = {}) {
    this.runFn = deps.runFn ?? defaultRunResearch;
    this.buildAgent = deps.buildAgent ?? defaultBuildAgent;
    this.log = deps.log ?? noopLogger;
  }

  /** Perform one run over the given topics+bounds; map the core's result onto a {@link RunnerResult}. */
  async execute(input: RunnerInput): Promise<RunnerResult> {
    const built = this.buildAgent(input.bounds, this.log);
    const { runAgent, submitBatch, tokens, topicsRun } = built;

    try {
      const result = await this.runFn({
        topics: input.topics,
        bounds: input.bounds,
        log: this.log,
        submitBatch,
        runAgent,
      });

      return { ...result, tokensUsed: tokens(), topicsRun: topicsRun() };
    } finally {
      // Flush in-flight tracing whether the run succeeded or threw. Best-effort and isolated — a flush
      // error must never mask the run's real result/error (ADR-0021). No-op when tracing is disabled.
      if (built.flushTracing) {
        await built.flushTracing().catch((err) => this.log.debug('tracer flush failed', { err: (err as Error)?.message ?? String(err) }));
      }
    }
  }
}

/**
 * Default production wiring: PubMed/medRxiv tools → relevance gate → extract → in-run dedup →
 * BotClient submit. A fresh {@link ResearchAgent} per topic (so its token tally is per-topic),
 * accumulating `tokensUsed` across topics and counting `topicsRun`, with BotClient pointed at the
 * lazily-resolved STRATEGY_API_URL seam and `ADMIN_API_SECRET`/`NCBI_API_KEY` read at call time.
 */
function defaultBuildAgent(bounds: Bounds, log: Logger): BuiltAgent {
  const client = new BotClient({ baseUrl: strategyApiUrl(), secret: process.env.ADMIN_API_SECRET || '' });
  // Insertion order is the agent's search/queue order (ADR-0036). OSF_TOKEN/NCBI_API_KEY read lazily
  // here (per-run, after ConfigModule loads), never frozen at import.
  const sources = new Map<SourceKind, Source>([
    ['pubmed', new PubMedTool({ apiKey: process.env.NCBI_API_KEY })],
    ['medrxiv', new MedrxivTool({ log })],
    ['psyarxiv', new PsyArxivTool({ token: process.env.OSF_TOKEN, log })],
  ]);

  // One tracer + one runId for the whole run (every topic's agent hangs under the same parent trace).
  // The tracer is a CLEAN no-op when Langfuse env is absent — `enabled` is re-read per call inside the
  // shared kernel, so this never depends on import-time env (CLAUDE.md lazy-config rule). Tracing is
  // additive: it never alters the run's counts and never throws out of a span (ADR-0021).
  const tracer = new ResearchTracer(log);
  const runId = crypto.randomUUID();

  let tokensUsed = 0;
  let topicsRun = 0;

  return {
    submitBatch: (cands) => client.submitBatch(cands),
    runAgent: async (topic) => {
      const agent = new ResearchAgent(
        { sources, seen: (id) => client.seen(id), gate: relevanceGate, extract: extractWithLenses, merge: mergeWithinPaper, judge: judgeCandidates, dedup: isDuplicateInRun },
        bounds,
        log,
        { tracer, runId },
      );
      const out = await agent.run(topic);
      topicsRun++;
      tokensUsed += agent.tokens;
      return { candidates: out.candidates, summary: out.summary, tokens: agent.tokens };
    },
    tokens: () => tokensUsed,
    topicsRun: () => topicsRun,
    flushTracing: () => tracer.onApplicationShutdown(),
  };
}
