import { readFileSync } from 'fs';
import { join } from 'path';
import { parseDatasetRows } from '../eval-env';

describe('parseDatasetRows', () => {
  const row = (over = ''): string =>
    `{"input":{"abstract":"a real abstract"},"expectedOutput":"keep","metadata":{"source":"pubmed","id":"PMID:1","topic":"t","bucket":"positive","modelLabel":"keep","reviewed":true}}${over}`;

  it('parses valid rows and skips blank lines', () => {
    const rows = parseDatasetRows(`${row()}\n\n${row()}\n`);
    expect(rows).toHaveLength(2);
    expect(rows[0].expectedOutput).toBe('keep');
  });

  it('throws with the line number on a bad expectedOutput', () => {
    const bad = row().replace('"expectedOutput":"keep"', '"expectedOutput":"kepe"');
    expect(() => parseDatasetRows(`${row()}\n${bad}`)).toThrow(/row 2:.*expectedOutput/);
  });

  it('throws on a missing/blank abstract', () => {
    const bad = row().replace('"abstract":"a real abstract"', '"abstract":""');
    expect(() => parseDatasetRows(bad)).toThrow(/abstract/);
  });

  it('throws on a wrong bucket vocabulary', () => {
    const bad = row().replace('"bucket":"positive"', '"bucket":"keep"');
    expect(() => parseDatasetRows(bad)).toThrow(/bucket/);
  });

  it('the checked-in dataset file is valid', () => {
    const file = join(__dirname, '../../evals/gate.dataset.jsonl');
    const rows = parseDatasetRows(readFileSync(file, 'utf8'));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(['keep', 'reject']).toContain(r.expectedOutput);
      expect(['positive', 'negative']).toContain(r.metadata.bucket);
    }
  });
});
