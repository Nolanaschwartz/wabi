/**
 * Seed the `research-gate` eval dataset in the EVAL Langfuse project from the checked-in JSONL.
 * Idempotent: each item is upserted on a stable id (`<source>:<id>`), so re-running never duplicates.
 *
 *   pnpm -F @wabi/research eval:seed
 *
 * Writes only to the eval project (separate keys). Touches no production data.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { DatasetRow, evalClient, evalKeys, GATE_DATASET, parseDatasetRows } from './eval-env';

const DATASET_FILE = join(__dirname, '../evals/gate.dataset.jsonl');

/** Stable, project-unique id for upsert — Langfuse upserts dataset items on this id. */
const itemId = (r: DatasetRow): string => `${r.metadata.source}:${r.metadata.id}`;

async function main(): Promise<void> {
  evalKeys(); // fail loud early if eval config is missing
  const client = evalClient();
  const rows = parseDatasetRows(readFileSync(DATASET_FILE, 'utf8')); // validates; throws on bad rows

  // The flat client.createDataset/createDatasetItem helpers are deprecated AND unbound (calling them
  // loses `this`); go through the bound api.* managers. datasets.create upserts on name, datasetItems
  // .create upserts on id — both idempotent, so re-running the seed never duplicates.
  await client.api.datasets.create({ name: GATE_DATASET, description: 'Relevance-gate eval (ADR-0040).' });

  for (const r of rows) {
    await client.api.datasetItems.create({
      datasetName: GATE_DATASET,
      id: itemId(r),
      input: r.input,
      expectedOutput: r.expectedOutput,
      metadata: r.metadata,
    });
    console.log(`upserted ${itemId(r)} (${r.expectedOutput})`);
  }
  console.log(`\nseeded ${rows.length} item(s) into "${GATE_DATASET}"`);
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
