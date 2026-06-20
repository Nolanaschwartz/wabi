/**
 * Run the CURRENT relevance gate over the `research-gate` eval dataset as a Langfuse experiment and
 * print quality metrics + the run URL.
 *
 *   pnpm -F @wabi/research eval:gate
 *
 * The task calls `relevanceGate(abstract)` directly — no agent, runner, or pipeline. Traces, the
 * dataset run, and scores all land in the EVAL Langfuse project (separate keys), never production.
 * The run is named with the current git SHA so runs are comparable across prompt revisions.
 */
import { execSync } from 'child_process';
import { relevanceGate } from '../src/agent/relevance-gate';
import { gateMetrics, GateItemResult, Label } from '../src/evals/gate-metrics';
import { evalClient, evalKeys, GATE_DATASET } from './eval-env';

// Repeats per item — the one trust knob. The gate calls a reasoning model whose determinism is
// unproven, so we run each abstract N times to measure flip-rate. Drop to 1 once flip-rate proves ~0.
const N_REPEATS = 3;

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'nogit';
  }
}

async function main(): Promise<void> {
  const keys = evalKeys(); // fail loud if eval config is missing

  // Route OTEL spans to the EVAL project by pointing the shared tracing bootstrap at the eval keys.
  // This process does nothing but the eval, so overriding the standard LANGFUSE_* vars in-process is
  // intentional and isolated — it never affects the production worker. Imported lazily so the env is
  // set before the bootstrap reads it.
  process.env.LANGFUSE_PUBLIC_KEY = keys.publicKey;
  process.env.LANGFUSE_SECRET_KEY = keys.secretKey;
  const { createLangfuseTracing } = await import('@wabi/shared/otel');
  const tracing = createLangfuseTracing({ serviceName: 'wabi-research-eval', sampleRate: 1 });

  const sha = gitSha();
  const client = evalClient(keys);
  // client.dataset.get (bound manager) — NOT the deprecated client.getDataset, which loses `this`.
  const dataset = await client.dataset.get(GATE_DATASET);

  const result = await dataset.runExperiment({
    name: 'gate',
    runName: `gate@${sha}`,
    description: 'Relevance-gate offline eval (ADR-0040, Phase 1).',
    metadata: { gitSha: sha },
    maxConcurrency: 4,
    task: async (item) => {
      const abstract = (item.input as { abstract: string }).abstract;
      const predictions: Label[] = [];
      const emptyReplies: boolean[] = [];
      for (let i = 0; i < N_REPEATS; i++) {
        const r = await relevanceGate(abstract);
        // empty: the gate produced no usable text (starved reasoning model or transport error) and
        // fell open to keep. Surfaced per call so the metrics score it faithfully and measure its rate.
        emptyReplies.push(!r.trace || (r.trace.output ?? '').trim() === '');
        predictions.push(r.keep ? 'keep' : 'reject');
      }
      return { predictions, emptyReplies };
    },
  });

  const items: GateItemResult[] = result.itemResults.map((it) => {
    const out = (it.output ?? {}) as { predictions?: Label[]; emptyReplies?: boolean[] };
    return {
      expected: it.expectedOutput as Label,
      predictions: out.predictions ?? [],
      emptyReplies: out.emptyReplies ?? [],
    };
  });
  const metrics = gateMetrics(items);

  await tracing.forceFlush();
  await tracing.shutdown();
  await client.flush();

  console.log(`\n=== gate eval @ ${sha} (${items.length} items × ${N_REPEATS} repeats) ===`);
  console.log(`accuracy:         ${metrics.accuracy.toFixed(3)}`);
  console.log(`reject precision: ${metrics.rejectPrecision.toFixed(3)}`);
  console.log(`reject recall:    ${metrics.rejectRecall.toFixed(3)}`);
  console.log(`flip rate:        ${metrics.flipRate.toFixed(3)}  (0 ⇒ single-run numbers are trustworthy)`);
  console.log(`empty-reply rate: ${metrics.emptyReplyRate.toFixed(3)}  (fail-open keeps masking accuracy)`);
  if (result.datasetRunUrl) console.log(`\nLangfuse run: ${result.datasetRunUrl}`);
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
