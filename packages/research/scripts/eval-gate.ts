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
      const r = await relevanceGate(abstract);
      // emptyReply: the gate produced no usable text (starved reasoning model or transport error) and
      // fell open to keep. Surfaced so the metrics score it faithfully as a keep.
      const emptyReply = !r.trace || (r.trace.output ?? '').trim() === '';
      return { keep: r.keep, emptyReply };
    },
  });

  const items: GateItemResult[] = result.itemResults.map((it) => {
    const out = (it.output ?? {}) as { keep?: boolean; emptyReply?: boolean };
    return {
      expected: it.expectedOutput as Label,
      predictions: [out.keep === false ? 'reject' : 'keep'],
      emptyReply: out.emptyReply === true,
    };
  });
  const metrics = gateMetrics(items);

  await tracing.forceFlush();
  await tracing.shutdown();
  await client.flush();

  console.log(`\n=== gate eval @ ${sha} (${items.length} items) ===`);
  console.log(`accuracy:        ${metrics.accuracy.toFixed(3)}`);
  console.log(`reject precision: ${metrics.rejectPrecision.toFixed(3)}`);
  console.log(`reject recall:    ${metrics.rejectRecall.toFixed(3)}`);
  if (result.datasetRunUrl) console.log(`\nLangfuse run: ${result.datasetRunUrl}`);
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
