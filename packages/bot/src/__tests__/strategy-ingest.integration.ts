// pg-boss is ESM and only touched by StrategyAdminService.init() (which this test never calls —
// it drives ingestCandidate directly). Mock it so jest can parse the import while Postgres +
// Qdrant remain real.
jest.mock('pg-boss', () => ({
  PgBoss: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    createQueue: jest.fn().mockResolvedValue(undefined),
    work: jest.fn().mockResolvedValue(undefined),
    send: jest.fn().mockResolvedValue('job_1'),
    schedule: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { randomUUID } from 'crypto';
import { startInfra } from '../integration-harness';
import { VECTOR_SIZE } from '../modules/strategy-retrieval/strategy-retrieval.service';

// The real fetch, captured once before any mocking. Qdrant's REST client also uses global.fetch,
// so the embed mock must delegate non-embedding requests here rather than swallow them.
const realFetch = global.fetch;

// Deterministic embeddings: each strategy gets a distinct unit vector so cosine similarity is
// predictable. The dedup test depends on "Box Breathing" content embedding to the SAME vector
// for both the upserted published point and the isDuplicate search query.
function mockEmbed(text: string): number[] {
  const v = new Array(VECTOR_SIZE).fill(0);
  if (text.includes('Box Breathing')) {
    v[0] = 1;
  } else if (text.includes('Cold Plunge')) {
    v[1] = 1;
  } else {
    v[2] = 1;
  }
  return v;
}

// Mock only the embedding endpoint (the retrieval service POSTs to `${baseUrl}/v1/embeddings`
// with { input: text }); pass Qdrant's own HTTP through to the real container.
function installEmbedMock(): void {
  global.fetch = jest.fn().mockImplementation((url: string, opts: any) => {
    if (typeof url === 'string' && url.includes('/v1/embeddings')) {
      const body = JSON.parse(opts.body);
      return Promise.resolve({
        ok: true,
        json: async () => ({ data: [{ embedding: mockEmbed(body.input) }] }),
      });
    }
    return realFetch(url as any, opts);
  }) as unknown as typeof fetch;
}

describe('strategy ingest integration', () => {
  let infra: Awaited<ReturnType<typeof startInfra>>;
  let svc: any;

  beforeAll(async () => {
    infra = await startInfra();
    process.env.DATABASE_URL = infra.postgresUrl;
    process.env.QDRANT_URL = infra.qdrantUrl;
    process.env.RESEARCH_DEDUP_THRESHOLD = '0.95';

    installEmbedMock();

    // The @wabi/shared prisma singleton is cached on globalThis at module-load time (before
    // DATABASE_URL pointed at the container). Drop it so the dynamic import below reconstructs
    // it against the test database.
    delete (globalThis as { prisma?: unknown }).prisma;
    jest.resetModules();

    const { StrategyAdminService } = await import('../modules/strategy-admin/strategy-admin.service');
    const { StrategyRetrievalService } = await import(
      '../modules/strategy-retrieval/strategy-retrieval.service'
    );

    const retrieval = new StrategyRetrievalService(infra.qdrantUrl);
    await retrieval.init();

    // Auto-pass trust gate: never run the real LLM safety/faithfulness calls. 'queue' forces
    // pending-review (submitDraft only publishes on a 'publish' decision), matching the
    // research-agent contract — this endpoint can never auto-publish.
    const trustGateAutoPass = {
      evaluate: jest.fn().mockResolvedValue({ decision: 'queue', reason: 'test' }),
      shouldQuarantine: jest.fn().mockReturnValue(false),
    };

    // Scheduler is unused by ingestCandidate (only init() registers workers, which the test
    // never calls). Degraded shape is enough.
    const scheduler = {
      available: false,
      work: jest.fn(),
      cron: jest.fn(),
      send: jest.fn(),
    };

    svc = new StrategyAdminService(trustGateAutoPass as any, retrieval, scheduler as any, {
      declare: jest.fn(),
    } as any);
  }, 90000);

  afterAll(async () => {
    global.fetch = realFetch;
    const { prisma } = await import('@wabi/shared');
    await prisma.$disconnect();
    await infra.stop();
  }, 30000);

  it('queues a novel candidate, records the ledger, and reports it seen — not yet retrievable', async () => {
    const res = await svc.ingestCandidate({
      title: 'Box Breathing',
      technique: 'inhale 4 hold 4 exhale 4',
      source: 'PubMed',
      evidence: 'peer-reviewed: RCT',
      sourceText: 'box breathing lowered anxiety',
      sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/111',
      sourceId: 'PMID:111',
      sourceKind: 'pubmed',
    });
    expect(res.status).toBe('submitted');
    expect(res.draftId).toBeTruthy();

    const { prisma } = await import('@wabi/shared');
    const draft = await prisma.strategyDraft.findUnique({ where: { id: res.draftId } });
    // Queued for human review — never auto-published from the research-agent path (ADR-0033).
    expect(draft?.status).toBe('pending-review');

    // Source-level ledger records the terminal outcome (ADR-0033 idempotency).
    expect(await svc.hasSeen('PMID:111')).toBe(true);
  }, 30000);

  it('dedupes a near-identical candidate against a published strategy (409 path)', async () => {
    // Publish a Box-Breathing point directly into the index, mirroring the "title: technique"
    // content the admin service indexes from (publishToQdrant), so the dedup query matches.
    const { StrategyRetrievalService } = await import(
      '../modules/strategy-retrieval/strategy-retrieval.service'
    );
    const retrieval = new StrategyRetrievalService(infra.qdrantUrl);
    await retrieval.init();
    await retrieval.upsert(
      randomUUID(),
      'Box Breathing: inhale 4 hold 4 exhale 4',
      'peer-reviewed: RCT',
    );
    // Qdrant upserts are applied asynchronously; let the indexer catch up before the dedup search.
    await new Promise((r) => setTimeout(r, 1000));

    const res = await svc.ingestCandidate({
      title: 'Box Breathing',
      technique: 'inhale 4 hold 4 exhale 4',
      source: 'PubMed',
      evidence: 'peer-reviewed: RCT',
      sourceText: 'box breathing lowered anxiety',
      sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/222',
      sourceId: 'PMID:222',
      sourceKind: 'pubmed',
    });
    // Same "Box Breathing: ..." content → identical vector → cosine 1.0 ≥ 0.95 → deduped.
    expect(res.status).toBe('deduped');
    expect(res.draftId).toBeUndefined();
    expect(await svc.hasSeen('PMID:222')).toBe(true);
  }, 30000);
});
