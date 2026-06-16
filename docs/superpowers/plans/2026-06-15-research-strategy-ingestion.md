# Research-driven Strategy Ingestion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the research pipeline that autonomously discovers evidence-based coaching strategies from PubMed + medRxiv, extracts grounded technique candidates, and submits them to the bot's human-review queue — never auto-publishing (ADR-0033).

**Architecture:** Two layers. **Part A** adds the bot's ingest surface: a `research-agent` trust level that always queues, a `ProcessedSource` ledger, and two authenticated endpoints (`POST /admin/strategies/ingest`, `GET /admin/strategies/seen`). **Part B** adds an isolated `packages/research` worker that does the agentic discovery/extraction and talks to the bot only over those endpoints. Part A is independently testable (curl the endpoints) and must land first; Part B depends on it.

**Tech Stack:** TypeScript, NestJS 11 (bot), plain TS worker, Prisma/Postgres, Qdrant (768-dim), `ai` + `@ai-sdk/openai` SDK, NCBI E-utilities + medRxiv HTTP APIs, Jest + ts-jest, testcontainers.

**Spec:** `docs/superpowers/specs/2026-06-15-research-strategy-ingestion-design.md`
**ADRs:** 0033 (always-queues + `research-agent` level), 0012 (trust gate), 0002 (privacy), 0017 (768-dim), 0019/0020 (always-on bot).
**Branch:** `feat/research-strategy-ingestion`

---

## File Structure

**Part A — bot (modify):**
- `packages/shared/src/provider.ts` — add `research` + `research-triage` provider roles.
- `packages/shared/prisma/schema.prisma` — add `ProcessedSource` model.
- `packages/bot/src/modules/strategy-admin/strategy-trust-gate.ts` — add `research-agent` to the `StrategyDraft.trustLevel` union + an always-queue-after-checks branch.
- `packages/bot/src/modules/strategy-retrieval/strategy-retrieval.service.ts` — expose similarity `score` on `StrategyPoint`.
- `packages/bot/src/modules/strategy-admin/strategy-admin.service.ts` — `isDuplicate`, `hasSeen`, `markProcessed`, `ingestCandidate`.
- `packages/bot/src/modules/strategy-admin/strategy-admin.controller.ts` — `POST ingest`, `GET seen`.
- Tests alongside each, plus `packages/bot/src/__tests__/strategy-ingest.integration.ts`.

**Part B — worker (create) `packages/research/`:**
- `package.json`, `tsconfig.json`, `jest.config.js`
- `src/types.ts` — `Paper`, `Candidate`, `Bounds`, `RunSummary`, `SourceKind`
- `src/config.ts` — bounds + env loader
- `src/seed-topics.ts` — curated topic list
- `src/util/rate-limiter.ts` — serialized throttle
- `src/sources/pubmed.ts` — `PubMedTool`
- `src/sources/medrxiv.ts` — `MedrxivTool`
- `src/agent/relevance-gate.ts` — `relevanceGate`
- `src/agent/extract.ts` — `extract` + `evidenceTag`
- `src/agent/dedup.ts` — `isDuplicateInRun`
- `src/agent/research-agent.ts` — `ResearchAgent`
- `src/bot-client.ts` — `BotClient`
- `src/run.ts` — entrypoint
- `src/**/__tests__/*.spec.ts`

---

# PART A — Bot ingest surface

## Task 1: Add `research` + `research-triage` provider roles

**Files:**
- Modify: `packages/shared/src/provider.ts`
- Test: `packages/shared/src/__tests__/provider.spec.ts` (create; shared has no jest yet — see Step 0)

- [ ] **Step 0: Give `@wabi/shared` a test runner**

`packages/shared` has no jest config. Add dev deps and a `test` script so the role test (and future shared tests) run under `pnpm -r test`.

In `packages/shared/package.json`, add to `devDependencies`: `"jest": "^29.7.0"`, `"ts-jest": "^29.2.0"`, `"@types/jest": "^29.5.14"`. Add to `scripts`: `"test": "jest"`. Create `packages/shared/jest.config.js`:

```js
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js'],
  testMatch: ['**/__tests__/**/*.spec.ts', '**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { diagnostics: false }] },
};
```

Run: `pnpm -F @wabi/shared install` (from repo root) — expected: installs jest.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/__tests__/provider.spec.ts`:

```ts
import { getProvider } from '../provider';

describe('getProvider research roles', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('resolves the research role from env, lazily', () => {
    process.env.RESEARCH_BASE_URL = 'http://infer.local/v1';
    process.env.RESEARCH_MODEL = 'research-model';
    process.env.RESEARCH_API_KEY = 'k1';
    const cfg = getProvider('research');
    expect(cfg).toEqual({ baseUrl: 'http://infer.local/v1', model: 'research-model', apiKey: 'k1' });
  });

  it('falls back research-triage to the classifier env when its own is unset', () => {
    delete process.env.RESEARCH_TRIAGE_BASE_URL;
    process.env.CLASSIFIER_BASE_URL = 'http://classify.local/v1';
    const cfg = getProvider('research-triage');
    expect(cfg.baseUrl).toBe('http://classify.local/v1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @wabi/shared test -- provider.spec.ts`
Expected: FAIL — `'research'`/`'research-triage'` not assignable to `ProviderRole`.

- [ ] **Step 3: Implement**

In `packages/shared/src/provider.ts`, extend the union and the map. The triage role defaults to the classifier env (it is a cheap, fast model), so an operator can share one small model or split later:

```ts
export type ProviderRole =
  | 'coach' | 'classifier' | 'embedding' | 'router' | 'research' | 'research-triage';
```

Add inside the `providerConfig` object (after `router`):

```ts
    // Capable extraction model for the research worker — faithful, generalized technique
    // extraction with verbatim grounding. Self-controlled tier in production.
    research: {
      baseUrl: process.env.RESEARCH_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.RESEARCH_MODEL || 'gpt-4o',
      apiKey: process.env.RESEARCH_API_KEY || '',
    },
    // Cheap, high-volume triage for the research worker's relevance gate + in-run dedup.
    // Defaults to the classifier tier so it can share one small model unless split out.
    'research-triage': {
      baseUrl: process.env.RESEARCH_TRIAGE_BASE_URL || process.env.CLASSIFIER_BASE_URL || 'https://api.openai.com/v1',
      model: process.env.RESEARCH_TRIAGE_MODEL || process.env.CLASSIFIER_MODEL || 'gpt-4o-mini',
      apiKey: process.env.RESEARCH_TRIAGE_API_KEY || process.env.CLASSIFIER_API_KEY || '',
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @wabi/shared test -- provider.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Document the env vars**

In `.env.example`, add a `# --- Research worker (Part B) ---` block: `RESEARCH_BASE_URL=`, `RESEARCH_MODEL=`, `RESEARCH_API_KEY=`, `RESEARCH_TRIAGE_BASE_URL=`, `RESEARCH_TRIAGE_MODEL=`, `RESEARCH_TRIAGE_API_KEY=` (all blank, with a comment that triage falls back to `CLASSIFIER_*`).

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add research + research-triage provider roles (ADR-0033)"
```

---

## Task 2: Trust gate — `research-agent` level always queues after checks

The override from ADR-0033: research drafts run safety + faithfulness (so a reviewer never sees something that failed them) but the result can only gate-to-queue, never publish.

**Files:**
- Modify: `packages/bot/src/modules/strategy-admin/strategy-trust-gate.ts`
- Test: `packages/bot/src/modules/strategy-admin/__tests__/strategy-trust-gate.spec.ts`

- [ ] **Step 1: Write the failing tests**

Append to the existing `describe('StrategyTrustGate', …)` block:

```ts
  it('routes research-agent draft to queue even when allowlisted + safe + faithful (ADR-0033 override)', async () => {
    const { generateText } = require('ai') as { generateText: jest.Mock };
    generateText
      .mockResolvedValueOnce({ text: 'safe' })
      .mockResolvedValueOnce({ text: 'faithful' });

    const result = await gate.evaluate({
      id: '1', title: 'PMR', technique: 'Tense and release major muscle groups for 5 min',
      source: 'PubMed', evidence: 'peer-reviewed: RCT',
      sourceText: 'progressive muscle relaxation reduced state anxiety',
      sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/12345', // ncbi is allowlisted
      trustLevel: 'research-agent', status: 'draft',
    });

    expect(result.decision).toBe('queue'); // NOT 'publish'
  });

  it('rejects a research-agent draft that fails safety (never reaches the reviewer)', async () => {
    const { generateText } = require('ai') as { generateText: jest.Mock };
    generateText.mockResolvedValueOnce({ text: 'unsafe' });

    const result = await gate.evaluate({
      id: '1', title: 'X', technique: 'Y', source: 'PubMed', evidence: 'peer-reviewed: RCT',
      sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/12345',
      trustLevel: 'research-agent', status: 'draft',
    });

    expect(result.decision).toBe('reject');
  });
```

- [ ] **Step 2: Run to verify failure**

Run (from `packages/bot`): `pnpm test -- strategy-trust-gate.spec.ts`
Expected: FAIL — `'research-agent'` not assignable to `trustLevel`; first test gets `publish`.

- [ ] **Step 3: Implement**

In `strategy-trust-gate.ts`, widen the union:

```ts
  trustLevel: 'allowlisted' | 'community' | 'session-mined' | 'research-agent';
```

In `evaluate`, immediately after the `session-mined` branch (before the allowlist check), add:

```ts
    // Research-agent drafts (ADR-0033): safety + faithfulness still run so a reviewer never
    // sees something that failed them, but they can only gate-to-queue — never auto-publish,
    // even from an allowlisted source. The human gate is mandatory for agent-discovered advice.
    if (draft.trustLevel === 'research-agent') {
      if (!(await this.safetyFilter(draft))) {
        return { decision: 'reject', reason: 'Failed safety filter' };
      }
      if (!(await this.faithfulnessCheck(draft))) {
        return { decision: 'reject', reason: 'Technique not faithful to cited source' };
      }
      return { decision: 'queue', reason: 'Research-agent draft — safe + faithful, queued for human review' };
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- strategy-trust-gate.spec.ts`
Expected: PASS (all, including the 2 new).

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/modules/strategy-admin/strategy-trust-gate.ts packages/bot/src/modules/strategy-admin/__tests__/strategy-trust-gate.spec.ts
git commit -m "feat(strategy): research-agent trust level always queues (ADR-0033)"
```

---

## Task 3: Expose similarity score for dedup

`StrategyRetrievalService.search` drops Qdrant's `score`; dedup needs it. Adding an optional field is backward-compatible (existing consumers ignore it).

**Files:**
- Modify: `packages/bot/src/modules/strategy-retrieval/strategy-retrieval.service.ts`
- Test: `packages/bot/src/__tests__/strategy-retrieval.integration.ts`

- [ ] **Step 1: Write the failing test**

Append a test inside `describe('strategy retrieval integration', …)`:

```ts
  it('exposes a similarity score on results', async () => {
    await retrieval.upsert(randomUUID(), 'Box Breathing for anxiety', 'RCT meta-analysis');
    const results = await searchWithRetry(retrieval, 'reset anxiety');
    expect(typeof results[0].score).toBe('number');
    expect(results[0].score).toBeGreaterThan(0.5);
  }, 30000);
```

- [ ] **Step 2: Run to verify failure**

Run (Docker required): `pnpm test:integration -- strategy-retrieval.integration.ts`
Expected: FAIL — `score` is `undefined`.

- [ ] **Step 3: Implement**

Add `score?: number;` to the `StrategyPoint` interface, and in `search`'s `.map`, add `score: point.score as number,`.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test:integration -- strategy-retrieval.integration.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/modules/strategy-retrieval/strategy-retrieval.service.ts packages/bot/src/__tests__/strategy-retrieval.integration.ts
git commit -m "feat(strategy-retrieval): expose similarity score for dedup"
```

---

## Task 4: `ProcessedSource` ledger model

**Files:**
- Modify: `packages/shared/prisma/schema.prisma`

- [ ] **Step 1: Add the model**

After the `StrategyDraft` model, add:

```prisma
// Source-level idempotency ledger for the research pipeline (ADR-0033). ID-only — never any
// paper content or personal data. Written by the bot at ingest; read by the worker via GET seen.
model ProcessedSource {
  sourceId    String   @id          // "PMID:12345" | "doi:10.1101/2024.01.01.24300000"
  source      String                // 'pubmed' | 'medrxiv'
  lastStatus  String                // 'submitted' | 'deduped' | 'rejected'
  firstSeenAt DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

- [ ] **Step 2: Generate client + push schema**

Run (from repo root): `pnpm db:generate && pnpm db:push`
Expected: client regenerated; `ProcessedSource` table created. (Local Postgres must be up: `docker compose up -d postgres`.)

- [ ] **Step 3: Commit**

```bash
git add packages/shared/prisma/schema.prisma
git commit -m "feat(db): add ProcessedSource ledger for research idempotency (ADR-0033)"
```

---

## Task 5: Service — `isDuplicate` against the published library

**Files:**
- Modify: `packages/bot/src/modules/strategy-admin/strategy-admin.service.ts`
- Test: `packages/bot/src/modules/strategy-admin/__tests__/strategy-admin.service.spec.ts`

- [ ] **Step 1: Write the failing test**

Open the existing service spec to mirror its mock setup, then add a `describe('isDuplicate', …)`. The service takes `(trustGate, retrieval, scheduler)`; mock `retrieval.search`:

```ts
import { StrategyAdminService } from '../strategy-admin.service';

describe('StrategyAdminService.isDuplicate', () => {
  const retrieval = { search: jest.fn() } as any;
  const trustGate = {} as any;
  const scheduler = {} as any;
  let svc: StrategyAdminService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RESEARCH_DEDUP_THRESHOLD = '0.95';
    svc = new StrategyAdminService(trustGate, retrieval, scheduler);
  });

  it('is a duplicate when the top match scores at/above threshold', async () => {
    retrieval.search.mockResolvedValue([{ id: 'a', content: 'x', evidence: 'y', score: 0.97 }]);
    expect(await svc.isDuplicate('PMR', 'tense and release')).toBe(true);
    expect(retrieval.search).toHaveBeenCalledWith('PMR: tense and release', 1);
  });

  it('is not a duplicate below threshold', async () => {
    retrieval.search.mockResolvedValue([{ id: 'a', content: 'x', evidence: 'y', score: 0.4 }]);
    expect(await svc.isDuplicate('PMR', 'tense and release')).toBe(false);
  });

  it('is not a duplicate when the library is empty', async () => {
    retrieval.search.mockResolvedValue([]);
    expect(await svc.isDuplicate('PMR', 'tense and release')).toBe(false);
  });
});
```

> Note: if the existing service spec already constructs the service with full mocks, add these cases there using its established mock objects instead of re-declaring; the assertions are what matter.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- strategy-admin.service.spec.ts`
Expected: FAIL — `isDuplicate` is not a function.

- [ ] **Step 3: Implement**

Add near the top of `strategy-admin.service.ts` (module scope):

```ts
// Cosine similarity at/above this counts a candidate as already-present (ADR-0012 dedup).
// Resolved lazily per call — never cache env-derived config (CLAUDE.md).
function dedupThreshold(): number {
  return parseFloat(process.env.RESEARCH_DEDUP_THRESHOLD || '0.95');
}
```

Add the method to the class:

```ts
  /** True when the published library already contains a near-identical strategy. Queries the same
   * "title: technique" string the index is built from (publishToQdrant), so query and corpus match. */
  async isDuplicate(title: string, technique: string): Promise<boolean> {
    const [top] = await this.retrieval.search(`${title}: ${technique}`, 1);
    return !!top && typeof top.score === 'number' && top.score >= dedupThreshold();
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- strategy-admin.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/modules/strategy-admin/strategy-admin.service.ts packages/bot/src/modules/strategy-admin/__tests__/strategy-admin.service.spec.ts
git commit -m "feat(strategy-admin): isDuplicate library check for research ingest"
```

---

## Task 6: Service — `hasSeen` + `markProcessed` ledger access

**Files:**
- Modify: `packages/bot/src/modules/strategy-admin/strategy-admin.service.ts`
- Test: `packages/bot/src/modules/strategy-admin/__tests__/strategy-admin.service.spec.ts`

- [ ] **Step 1: Write the failing test**

The service uses the `@wabi/shared` `prisma` singleton. Mock it at the top of the spec file (if not already mocked there):

```ts
jest.mock('@wabi/shared', () => ({
  prisma: {
    processedSource: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
    strategyDraft: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  },
  getProvider: jest.fn().mockReturnValue({ baseUrl: '', model: '', apiKey: '' }),
}));
```

Add:

```ts
import { prisma } from '@wabi/shared';

describe('StrategyAdminService ledger', () => {
  const svc = new StrategyAdminService({} as any, { search: jest.fn() } as any, {} as any);
  beforeEach(() => jest.clearAllMocks());

  it('hasSeen returns true when a row exists', async () => {
    (prisma.processedSource.findUnique as jest.Mock).mockResolvedValue({ sourceId: 'PMID:1' });
    expect(await svc.hasSeen('PMID:1')).toBe(true);
  });

  it('hasSeen returns false when absent', async () => {
    (prisma.processedSource.findUnique as jest.Mock).mockResolvedValue(null);
    expect(await svc.hasSeen('PMID:9')).toBe(false);
  });

  it('markProcessed upserts the ledger row', async () => {
    await svc.markProcessed('PMID:1', 'pubmed', 'submitted');
    expect(prisma.processedSource.upsert).toHaveBeenCalledWith({
      where: { sourceId: 'PMID:1' },
      create: { sourceId: 'PMID:1', source: 'pubmed', lastStatus: 'submitted' },
      update: { lastStatus: 'submitted' },
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- strategy-admin.service.spec.ts`
Expected: FAIL — methods undefined.

- [ ] **Step 3: Implement**

Add to the class:

```ts
  /** Source-level idempotency: has this paper been processed on any prior run? (ADR-0033) */
  async hasSeen(sourceId: string): Promise<boolean> {
    const row = await prisma.processedSource.findUnique({ where: { sourceId } });
    return row !== null;
  }

  /** Record a terminal ingest outcome for a source. Upsert keeps firstSeenAt, refreshes lastStatus. */
  async markProcessed(
    sourceId: string,
    source: string,
    status: 'submitted' | 'deduped' | 'rejected',
  ): Promise<void> {
    await prisma.processedSource.upsert({
      where: { sourceId },
      create: { sourceId, source, lastStatus: status },
      update: { lastStatus: status },
    });
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- strategy-admin.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/modules/strategy-admin/strategy-admin.service.ts packages/bot/src/modules/strategy-admin/__tests__/strategy-admin.service.spec.ts
git commit -m "feat(strategy-admin): ProcessedSource hasSeen + markProcessed"
```

---

## Task 7: Service — `ingestCandidate` orchestration

Dedup → reject/queue via the trust gate → record the ledger. Records on every candidate-producing outcome (submitted / deduped / rejected) per the spec's v1 write-timing. Forces `trustLevel: 'research-agent'` so the endpoint can't be used to inject an auto-publishing draft.

**Files:**
- Modify: `packages/bot/src/modules/strategy-admin/strategy-admin.service.ts`
- Test: `packages/bot/src/modules/strategy-admin/__tests__/strategy-admin.service.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('StrategyAdminService.ingestCandidate', () => {
  let svc: StrategyAdminService;
  const trustGate = { evaluate: jest.fn() } as any;
  const retrieval = { search: jest.fn() } as any;

  const candidate = {
    title: 'PMR', technique: 'tense and release', source: 'PubMed',
    evidence: 'peer-reviewed: RCT', sourceText: 'progressive muscle relaxation reduced anxiety',
    sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/12345',
    sourceId: 'PMID:12345', sourceKind: 'pubmed',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RESEARCH_DEDUP_THRESHOLD = '0.95';
    svc = new StrategyAdminService(trustGate, retrieval, {} as any);
    jest.spyOn(svc, 'markProcessed').mockResolvedValue();
  });

  it('returns deduped and records the ledger when a near-duplicate exists', async () => {
    retrieval.search.mockResolvedValue([{ id: 'a', content: '', evidence: '', score: 0.99 }]);
    const res = await svc.ingestCandidate(candidate as any);
    expect(res.status).toBe('deduped');
    expect(svc.markProcessed).toHaveBeenCalledWith('PMID:12345', 'pubmed', 'deduped');
  });

  it('returns rejected (and does not persist) when the trust gate rejects', async () => {
    retrieval.search.mockResolvedValue([]);
    trustGate.evaluate.mockResolvedValue({ decision: 'reject', reason: 'Failed safety filter' });
    jest.spyOn(svc, 'submitDraft');
    const res = await svc.ingestCandidate(candidate as any);
    expect(res.status).toBe('rejected');
    expect(svc.submitDraft).not.toHaveBeenCalled();
    expect(svc.markProcessed).toHaveBeenCalledWith('PMID:12345', 'pubmed', 'rejected');
  });

  it('submits a novel, safe candidate as a queued draft and forces research-agent trust', async () => {
    retrieval.search.mockResolvedValue([]);
    trustGate.evaluate.mockResolvedValue({ decision: 'queue', reason: 'ok' });
    jest.spyOn(svc, 'submitDraft').mockResolvedValue({ id: 'draft-1', status: 'pending-review' } as any);
    const res = await svc.ingestCandidate(candidate as any);
    expect(res).toEqual({ status: 'submitted', draftId: 'draft-1' });
    const submitted = (svc.submitDraft as jest.Mock).mock.calls[0][0];
    expect(submitted.trustLevel).toBe('research-agent');
    expect(svc.markProcessed).toHaveBeenCalledWith('PMID:12345', 'pubmed', 'submitted');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- strategy-admin.service.spec.ts`
Expected: FAIL — `ingestCandidate` undefined.

- [ ] **Step 3: Implement**

Add the import at the top if absent: `import { randomUUID } from 'crypto';`. Add the payload type above the class:

```ts
export interface IngestCandidate {
  id?: string;
  title: string;
  technique: string;
  source: string;
  evidence: string;
  sourceText?: string;
  sourceUrl: string;
  sourceId: string;
  sourceKind: string;
}
```

Add the method:

```ts
  /**
   * Ingest one research candidate (ADR-0033). Layered: library dedup → trust gate (which, for
   * research-agent, runs safety+faithfulness but can only queue or reject) → ledger record. The
   * trust level is forced to 'research-agent' here so this endpoint can never auto-publish.
   */
  async ingestCandidate(
    c: IngestCandidate,
  ): Promise<{ status: 'submitted' | 'deduped' | 'rejected'; draftId?: string }> {
    if (await this.isDuplicate(c.title, c.technique)) {
      await this.markProcessed(c.sourceId, c.sourceKind, 'deduped');
      return { status: 'deduped' };
    }

    const draft: StrategyDraft = {
      id: c.id ?? randomUUID(),
      title: c.title,
      technique: c.technique,
      source: c.source,
      evidence: c.evidence,
      sourceText: c.sourceText,
      sourceUrl: c.sourceUrl,
      trustLevel: 'research-agent',
      status: 'draft',
    };

    // Evaluate up front so a safety/faithfulness rejection never persists (a reviewer must not see
    // a failed draft). On non-reject, submitDraft re-evaluates and persists as pending-review.
    const decision = await this.trustGate.evaluate(draft);
    if (decision.decision === 'reject') {
      await this.markProcessed(c.sourceId, c.sourceKind, 'rejected');
      return { status: 'rejected' };
    }

    const persisted = await this.submitDraft(draft);
    await this.markProcessed(c.sourceId, c.sourceKind, 'submitted');
    return { status: 'submitted', draftId: persisted.id };
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- strategy-admin.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/modules/strategy-admin/strategy-admin.service.ts packages/bot/src/modules/strategy-admin/__tests__/strategy-admin.service.spec.ts
git commit -m "feat(strategy-admin): ingestCandidate dedup→gate→ledger pipeline (ADR-0033)"
```

---

## Task 8: Controller — `POST ingest` + `GET seen`

**Files:**
- Modify: `packages/bot/src/modules/strategy-admin/strategy-admin.controller.ts`
- Test: `packages/bot/src/modules/strategy-admin/__tests__/strategy-admin.controller.spec.ts`

- [ ] **Step 1: Write the failing tests**

In the controller spec, extend the `service` mock object (in `beforeEach`) with `ingestCandidate: jest.fn()` and `hasSeen: jest.fn()`. Add:

```ts
import { ConflictException } from '@nestjs/common';

  it('ingests a novel candidate and returns the draft id', async () => {
    service.ingestCandidate.mockResolvedValue({ status: 'submitted', draftId: 'd1' });
    const res = await controller.ingest({ sourceId: 'PMID:1' } as any);
    expect(res).toEqual({ status: 'submitted', draftId: 'd1' });
  });

  it('maps a deduped candidate to 409 Conflict', async () => {
    service.ingestCandidate.mockResolvedValue({ status: 'deduped' });
    await expect(controller.ingest({ sourceId: 'PMID:1' } as any)).rejects.toBeInstanceOf(ConflictException);
  });

  it('reports seen status', async () => {
    service.hasSeen.mockResolvedValue(true);
    expect(await controller.seen('PMID:1')).toEqual({ seen: true });
    expect(service.hasSeen).toHaveBeenCalledWith('PMID:1');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- strategy-admin.controller.spec.ts`
Expected: FAIL — `ingest`/`seen` undefined.

- [ ] **Step 3: Implement**

In `strategy-admin.controller.ts`, extend the imports and add two handlers (the class already has `@UseGuards(AdminGuard)`):

```ts
import { Controller, Get, Post, Body, Param, Query, HttpCode, HttpStatus, UseGuards, ConflictException } from '@nestjs/common';
import { IngestCandidate } from './strategy-admin.service';
```

```ts
  @Post('ingest')
  @HttpCode(HttpStatus.CREATED)
  async ingest(@Body() body: IngestCandidate) {
    const result = await this.admin.ingestCandidate(body);
    if (result.status === 'deduped') {
      // 409 so the worker can count it as a near-duplicate without treating it as an error.
      throw new ConflictException({ status: 'deduped' });
    }
    return result;
  }

  @Get('seen')
  async seen(@Query('sourceId') sourceId: string) {
    return { seen: await this.admin.hasSeen(sourceId) };
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- strategy-admin.controller.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/bot/src/modules/strategy-admin/strategy-admin.controller.ts packages/bot/src/modules/strategy-admin/__tests__/strategy-admin.controller.spec.ts
git commit -m "feat(strategy-admin): POST ingest + GET seen endpoints (ADR-0033)"
```

---

## Task 9: Integration test — ingest → queue → seen

**Files:**
- Create: `packages/bot/src/__tests__/strategy-ingest.integration.ts`

- [ ] **Step 1: Write the failing test**

Mirror the env/reset-modules pattern from `session-sweep.integration.ts` and the embed mock from `strategy-retrieval.integration.ts`:

```ts
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

const realFetch = global.fetch;

// Deterministic embeddings: identical text → identical vector → cosine 1.0 (duplicate);
// different text → orthogonal-ish → low score.
function mockEmbed(text: string): number[] {
  const v = new Array(VECTOR_SIZE).fill(0);
  if (text.includes('Box Breathing')) { v[0] = 1; }
  else if (text.includes('Cold Plunge')) { v[1] = 1; }
  else { v[2] = 1; }
  return v;
}
function installEmbedMock(): void {
  global.fetch = jest.fn().mockImplementation((url: string, opts: any) => {
    if (typeof url === 'string' && url.includes('/api/embeddings')) {
      const body = JSON.parse(opts.body);
      return Promise.resolve({ ok: true, json: async () => ({ data: [{ embedding: mockEmbed(body.input) }] }) });
    }
    return realFetch(url as any, opts);
  }) as unknown as typeof fetch;
}

describe('strategy ingest integration', () => {
  let infra: Awaited<ReturnType<typeof startInfra>>;
  let svc: any;
  let trustGateAutoPass: any;

  beforeAll(async () => {
    infra = await startInfra();
    process.env.DATABASE_URL = infra.postgresUrl;
    process.env.QDRANT_URL = infra.qdrantUrl;
    process.env.RESEARCH_DEDUP_THRESHOLD = '0.95';
    installEmbedMock();
    delete (globalThis as { prisma?: unknown }).prisma;
    jest.resetModules();

    const { StrategyAdminService } = await import('../modules/strategy-admin/strategy-admin.service');
    const { StrategyRetrievalService } = await import('../modules/strategy-retrieval/strategy-retrieval.service');
    const retrieval = new StrategyRetrievalService(infra.qdrantUrl);
    await retrieval.init();
    // Trust gate stub: always queue (skip the LLM safety/faithfulness calls in this storage test).
    trustGateAutoPass = { evaluate: jest.fn().mockResolvedValue({ decision: 'queue', reason: 'test' }) };
    const scheduler = { available: false, work: jest.fn(), cron: jest.fn(), send: jest.fn() };
    svc = new StrategyAdminService(trustGateAutoPass, retrieval, scheduler as any);
  }, 90000);

  afterAll(async () => {
    global.fetch = realFetch;
    const { prisma } = await import('@wabi/shared');
    await prisma.$disconnect();
    await infra.stop();
  }, 30000);

  it('queues a novel candidate, records the ledger, and reports it seen — not yet retrievable', async () => {
    const res = await svc.ingestCandidate({
      title: 'Box Breathing', technique: 'inhale 4 hold 4 exhale 4', source: 'PubMed',
      evidence: 'peer-reviewed: RCT', sourceText: 'box breathing lowered anxiety',
      sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/111', sourceId: 'PMID:111', sourceKind: 'pubmed',
    });
    expect(res.status).toBe('submitted');

    const { prisma } = await import('@wabi/shared');
    const draft = await prisma.strategyDraft.findUnique({ where: { id: res.draftId } });
    expect(draft?.status).toBe('pending-review'); // queued, NOT published

    expect(await svc.hasSeen('PMID:111')).toBe(true);
  }, 30000);

  it('dedupes a near-identical candidate against a published strategy (409 path)', async () => {
    // Seed a PUBLISHED point with the same content the candidate will embed to.
    const { StrategyRetrievalService } = await import('../modules/strategy-retrieval/strategy-retrieval.service');
    const retrieval = new StrategyRetrievalService(infra.qdrantUrl);
    await retrieval.init();
    await retrieval.upsert(randomUUID(), 'Box Breathing: inhale 4 hold 4 exhale 4', 'peer-reviewed: RCT');
    await new Promise((r) => setTimeout(r, 1000)); // let Qdrant index

    const res = await svc.ingestCandidate({
      title: 'Box Breathing', technique: 'inhale 4 hold 4 exhale 4', source: 'PubMed',
      evidence: 'peer-reviewed: RCT', sourceText: 'box breathing lowered anxiety',
      sourceUrl: 'https://pubmed.ncbi.nlm.nih.gov/222', sourceId: 'PMID:222', sourceKind: 'pubmed',
    });
    expect(res.status).toBe('deduped');
    expect(await svc.hasSeen('PMID:222')).toBe(true);
  }, 30000);
});
```

- [ ] **Step 2: Run to verify it fails, then passes**

Run: `pnpm test:integration -- strategy-ingest.integration.ts`
Expected: initially may fail if any wiring is off; iterate until PASS (2 tests). Docker required.

- [ ] **Step 3: Commit**

```bash
git add packages/bot/src/__tests__/strategy-ingest.integration.ts
git commit -m "test(strategy-admin): integration for ingest queue + dedup + seen"
```

**Part A is now complete and independently shippable** — the bot exposes a guarded ingest/seen surface that always queues research drafts.

---

# PART B — Research worker (`packages/research`)

## Task 10: Scaffold the package

**Files:**
- Create: `packages/research/package.json`, `tsconfig.json`, `jest.config.js`, `src/types.ts`, `src/config.ts`, `src/seed-topics.ts`

- [ ] **Step 1: `package.json`**

```json
{
  "name": "@wabi/research",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "start": "ts-node src/run.ts"
  },
  "dependencies": {
    "@ai-sdk/openai": "^3.0.68",
    "@wabi/shared": "workspace:*",
    "ai": "^6.0.197"
  },
  "devDependencies": {
    "@types/jest": "^29.5.14",
    "@types/node": "^22.13.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.0",
    "ts-node": "^10.9.0",
    "typescript": "^5.8.2"
  },
  "jest": {
    "preset": "ts-jest",
    "testEnvironment": "node",
    "moduleFileExtensions": ["ts", "js"],
    "testMatch": ["**/__tests__/**/*.spec.ts", "**/*.spec.ts"],
    "transform": { "^.+\\.ts$": ["ts-jest", { "diagnostics": false }] }
  }
}
```

- [ ] **Step 2: `tsconfig.json`** (mirror the bot's, no decorators needed)

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "CommonJS", "moduleResolution": "node",
    "declaration": true, "sourceMap": true, "strict": true, "esModuleInterop": true,
    "skipLibCheck": true, "forceConsistentCasingInFileNames": true,
    "outDir": "dist", "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: `src/types.ts`**

```ts
export type SourceKind = 'pubmed' | 'medrxiv';

export interface Paper {
  sourceId: string;     // "PMID:12345" | "doi:10.1101/..."
  sourceKind: SourceKind;
  title: string;
  abstract: string;
  url: string;
  pubTypes: string[];   // [] for medRxiv
  isPreprint: boolean;
}

export interface Candidate {
  title: string;
  technique: string;
  sourceText: string;   // verbatim substring of the source body/abstract
  evidence: string;
  sourceUrl: string;
  source: string;       // descriptive label -> StrategyDraft.source
  sourceId: string;
  sourceKind: SourceKind;
  trustLevel: 'research-agent';
}

export interface Bounds {
  maxTopicsPerRun: number;
  maxPapersPerTopic: number;
  maxDiscoverySteps: number;
  maxDraftsPerTopic: number;
  maxDraftsPerRun: number;
  agentTimeoutMs: number;
  runTimeoutMs: number;
  tokenBudget: number;
}

export interface RunSummary {
  searched: number;
  seenSkipped: number;
  gatedOut: number;
  extracted: number;
  inRunDeduped: number;
  collected: number;
  submitted: number;
  libDeduped: number;
  errors: number;
  stopReason: string;
}
```

- [ ] **Step 4: `src/config.ts`**

```ts
import { Bounds } from './types';

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v === undefined ? fallback : Number(v);
}

/** Conservative, configurable bounds (spec §Bounds & budget). Resolved lazily per run. */
export function loadBounds(): Bounds {
  return {
    maxTopicsPerRun: num('RESEARCH_MAX_TOPICS_PER_RUN', 5),
    maxPapersPerTopic: num('RESEARCH_MAX_PAPERS_PER_TOPIC', 8),
    maxDiscoverySteps: num('RESEARCH_MAX_DISCOVERY_STEPS', 2),
    maxDraftsPerTopic: num('RESEARCH_MAX_DRAFTS_PER_TOPIC', 3),
    maxDraftsPerRun: num('RESEARCH_MAX_DRAFTS_PER_RUN', 10),
    agentTimeoutMs: num('RESEARCH_AGENT_TIMEOUT_MS', 90_000),
    runTimeoutMs: num('RESEARCH_RUN_TIMEOUT_MS', 600_000),
    tokenBudget: num('RESEARCH_TOKEN_BUDGET', 200_000),
  };
}
```

- [ ] **Step 5: `src/seed-topics.ts`**

```ts
// Curated gamer-wellbeing themes the agent starts from; it may branch to related papers (ADR-0033).
export const SEED_TOPICS: string[] = [
  'tilt emotion regulation competitive gaming',
  'gaming session break behavioral activation',
  'sleep hygiene late-night gaming young adults',
  'social anxiety online multiplayer communication',
  'rumination after loss cognitive reappraisal',
  'screen time self-regulation habit formation',
];
```

- [ ] **Step 6: Install + typecheck**

Run (repo root): `pnpm install` then `pnpm -F @wabi/research build`
Expected: installs; `tsc` compiles types.ts/config.ts/seed-topics.ts with no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/research/package.json packages/research/tsconfig.json packages/research/src/types.ts packages/research/src/config.ts packages/research/src/seed-topics.ts pnpm-lock.yaml
git commit -m "feat(research): scaffold worker package, types, bounds, seed topics"
```

---

## Task 11: Rate limiter util

**Files:**
- Create: `packages/research/src/util/rate-limiter.ts`, `packages/research/src/util/__tests__/rate-limiter.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { RateLimiter } from '../rate-limiter';

describe('RateLimiter', () => {
  it('serializes calls so two back-to-back run at least minIntervalMs apart', async () => {
    const limiter = new RateLimiter(50);
    const stamps: number[] = [];
    await Promise.all([
      limiter.schedule(async () => stamps.push(Date.now())),
      limiter.schedule(async () => stamps.push(Date.now())),
    ]);
    expect(stamps).toHaveLength(2);
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(45);
  });

  it('returns the task result', async () => {
    const limiter = new RateLimiter(1);
    expect(await limiter.schedule(async () => 42)).toBe(42);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F @wabi/research test -- rate-limiter.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/** Serializes async tasks with a minimum interval between starts — keeps NCBI under its rate cap
 * (3 req/s keyless) so a run can't get the IP blocked. */
export class RateLimiter {
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;

  constructor(private readonly minIntervalMs: number) {}

  schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.last);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      return task();
    });
    // Keep the chain alive even if a task rejects.
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm -F @wabi/research test -- rate-limiter.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/research/src/util
git commit -m "feat(research): serialized rate limiter for source APIs"
```

---

## Task 12: `PubMedTool` — search + summary + abstract + related + fullText

NCBI E-utilities return JSON for esearch/esummary/elink, plain text for efetch abstracts. Full text uses the PMC BioC JSON API (returns null when not open-access). All calls go through the rate limiter; `fetchFn` is injected for tests.

**Files:**
- Create: `packages/research/src/sources/pubmed.ts`, `packages/research/src/sources/__tests__/pubmed.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { PubMedTool } from '../pubmed';

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => '' });
}
function textResponse(body: string) {
  return Promise.resolve({ ok: true, status: 200, text: async () => body, json: async () => ({}) });
}

describe('PubMedTool', () => {
  it('search returns PMIDs from esearch', async () => {
    const fetchFn = jest.fn().mockReturnValue(jsonResponse({ esearchresult: { idlist: ['111', '222'] } }));
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    expect(await tool.search('tilt regulation', 8)).toEqual(['111', '222']);
    expect(fetchFn.mock.calls[0][0]).toContain('esearch.fcgi');
    expect(fetchFn.mock.calls[0][0]).toContain('retmax=8');
  });

  it('summary returns title + pubTypes from esummary', async () => {
    const fetchFn = jest.fn().mockReturnValue(jsonResponse({
      result: { '111': { uid: '111', title: 'PMR and anxiety', pubtype: ['Randomized Controlled Trial'] } },
    }));
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    const s = await tool.summary('111');
    expect(s).toEqual({ title: 'PMR and anxiety', pubTypes: ['Randomized Controlled Trial'] });
  });

  it('abstract returns efetch text', async () => {
    const fetchFn = jest.fn().mockReturnValue(textResponse('PMR reduced state anxiety in a trial.'));
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    expect(await tool.abstract('111')).toContain('PMR reduced state anxiety');
  });

  it('related returns neighbor PMIDs from elink', async () => {
    const fetchFn = jest.fn().mockReturnValue(jsonResponse({
      linksets: [{ linksetdbs: [{ links: ['333', '444'] }] }],
    }));
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    expect(await tool.related('111')).toEqual(['333', '444']);
  });

  it('fullText returns null when the paper is not open-access (no PMCID)', async () => {
    const fetchFn = jest.fn().mockReturnValue(jsonResponse({ result: { '111': { uid: '111', articleids: [] } } }));
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    expect(await tool.fullText('111')).toBeNull();
  });

  it('throws on HTTP error', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '', json: async () => ({}) });
    const tool = new PubMedTool({ fetchFn, minIntervalMs: 0 });
    await expect(tool.search('x', 8)).rejects.toThrow('503');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F @wabi/research test -- pubmed.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { RateLimiter } from '../util/rate-limiter';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const BIOC = 'https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json';

export interface PubMedDeps {
  fetchFn?: typeof fetch;
  apiKey?: string;
  minIntervalMs?: number; // default 350ms (~3/s keyless)
}

export class PubMedTool {
  private readonly fetchFn: typeof fetch;
  private readonly apiKey?: string;
  private readonly limiter: RateLimiter;

  constructor(deps: PubMedDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.apiKey = deps.apiKey;
    this.limiter = new RateLimiter(deps.minIntervalMs ?? 350);
  }

  private key(): string {
    return this.apiKey ? `&api_key=${this.apiKey}` : '';
  }

  private async getJson<T>(url: string): Promise<T> {
    return this.limiter.schedule(async () => {
      const res = await this.fetchFn(url);
      if (!res.ok) throw new Error(`PubMed HTTP ${res.status}`);
      return (await res.json()) as T;
    });
  }

  private async getText(url: string): Promise<string> {
    return this.limiter.schedule(async () => {
      const res = await this.fetchFn(url);
      if (!res.ok) throw new Error(`PubMed HTTP ${res.status}`);
      return res.text();
    });
  }

  async search(query: string, limit: number): Promise<string[]> {
    const url = `${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&retmax=${limit}&term=${encodeURIComponent(query)}${this.key()}`;
    const data = await this.getJson<{ esearchresult?: { idlist?: string[] } }>(url);
    return data.esearchresult?.idlist ?? [];
  }

  async summary(pmid: string): Promise<{ title: string; pubTypes: string[] }> {
    const url = `${EUTILS}/esummary.fcgi?db=pubmed&retmode=json&id=${pmid}${this.key()}`;
    const data = await this.getJson<{ result?: Record<string, { title?: string; pubtype?: string[] }> }>(url);
    const rec = data.result?.[pmid];
    return { title: rec?.title ?? '', pubTypes: rec?.pubtype ?? [] };
  }

  async abstract(pmid: string): Promise<string> {
    const url = `${EUTILS}/efetch.fcgi?db=pubmed&rettype=abstract&retmode=text&id=${pmid}${this.key()}`;
    return (await this.getText(url)).trim();
  }

  async related(pmid: string): Promise<string[]> {
    const url = `${EUTILS}/elink.fcgi?dbfrom=pubmed&db=pubmed&cmd=neighbor&retmode=json&id=${pmid}${this.key()}`;
    const data = await this.getJson<{ linksets?: { linksetdbs?: { links?: string[] }[] }[] }>(url);
    return data.linksets?.[0]?.linksetdbs?.[0]?.links ?? [];
  }

  /** PMC open-access full text via BioC JSON, or null when the paper isn't OA. */
  async fullText(pmid: string): Promise<string | null> {
    const sumUrl = `${EUTILS}/esummary.fcgi?db=pubmed&retmode=json&id=${pmid}${this.key()}`;
    const sum = await this.getJson<{ result?: Record<string, { articleids?: { idtype: string; value: string }[] }> }>(sumUrl);
    const pmcId = sum.result?.[pmid]?.articleids?.find((a) => a.idtype === 'pmc')?.value;
    if (!pmcId) return null;
    try {
      const bioc = await this.getJson<{ documents?: { passages?: { text?: string }[] }[] }>(
        `${BIOC}/${pmcId.replace('PMC', '')}/unicode`,
      );
      const text = (bioc.documents ?? [])
        .flatMap((d) => d.passages ?? [])
        .map((p) => p.text ?? '')
        .join('\n')
        .trim();
      return text.length > 0 ? text : null;
    } catch {
      return null; // not OA / transient — caller falls back to the abstract
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm -F @wabi/research test -- pubmed.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/research/src/sources/pubmed.ts packages/research/src/sources/__tests__/pubmed.spec.ts
git commit -m "feat(research): PubMedTool (search/summary/abstract/related/fullText)"
```

---

## Task 13: `MedrxivTool` — recent-window search with local filtering

medRxiv's public API has no free-text search; it serves preprints by date window. v1 fetches a recent window and filters locally on title/abstract (spec open question resolved this way). Full text is deferred — the details API already includes the abstract, which the agent reads.

**Files:**
- Create: `packages/research/src/sources/medrxiv.ts`, `packages/research/src/sources/__tests__/medrxiv.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { MedrxivTool } from '../medrxiv';

function jsonResponse(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

describe('MedrxivTool', () => {
  const collection = {
    collection: [
      { doi: '10.1101/2024.01.01.1', title: 'Tilt regulation in esports', abstract: 'emotion regulation reduced tilt', date: '2024-01-01' },
      { doi: '10.1101/2024.01.02.2', title: 'Knee surgery outcomes', abstract: 'orthopedic recovery', date: '2024-01-02' },
    ],
  };

  it('search returns only papers matching query terms, all flagged preprint', async () => {
    const fetchFn = jest.fn().mockReturnValue(jsonResponse(collection));
    const tool = new MedrxivTool({ fetchFn, minIntervalMs: 0, windowDays: 30, now: () => new Date('2024-01-31') });
    const papers = await tool.search('tilt regulation', 8);
    expect(papers).toHaveLength(1);
    expect(papers[0].title).toContain('Tilt regulation');
    expect(papers[0].isPreprint).toBe(true);
    expect(papers[0].sourceId).toBe('doi:10.1101/2024.01.01.1');
    expect(papers[0].sourceKind).toBe('medrxiv');
  });

  it('fullText returns null in v1 (abstract is read instead)', async () => {
    const tool = new MedrxivTool({ fetchFn: jest.fn(), minIntervalMs: 0 });
    expect(await tool.fullText('doi:10.1101/2024.01.01.1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F @wabi/research test -- medrxiv.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { RateLimiter } from '../util/rate-limiter';
import { Paper } from '../types';

const BASE = 'https://api.medrxiv.org/details/medrxiv';

export interface MedrxivDeps {
  fetchFn?: typeof fetch;
  minIntervalMs?: number;
  windowDays?: number;       // how far back to scan (default 60)
  now?: () => Date;          // injectable clock for tests
}

interface MedrxivRecord { doi: string; title: string; abstract: string; date: string }

export class MedrxivTool {
  private readonly fetchFn: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly windowDays: number;
  private readonly now: () => Date;

  constructor(deps: MedrxivDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.limiter = new RateLimiter(deps.minIntervalMs ?? 1000);
    this.windowDays = deps.windowDays ?? 60;
    this.now = deps.now ?? (() => new Date());
  }

  private fmt(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /** Fetch a recent window of preprints and keep those whose title/abstract contains every query
   * term (case-insensitive). The API includes the abstract, so no extra fetch is needed. */
  async search(query: string, limit: number): Promise<Paper[]> {
    const to = this.now();
    const from = new Date(to.getTime() - this.windowDays * 86_400_000);
    const url = `${BASE}/${this.fmt(from)}/${this.fmt(to)}/0/json`;
    const data = await this.limiter.schedule(async () => {
      const res = await this.fetchFn(url);
      if (!res.ok) throw new Error(`medRxiv HTTP ${res.status}`);
      return (await res.json()) as { collection?: MedrxivRecord[] };
    });

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (r: MedrxivRecord) => {
      const hay = `${r.title} ${r.abstract}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    };

    return (data.collection ?? [])
      .filter(matches)
      .slice(0, limit)
      .map((r) => ({
        sourceId: `doi:${r.doi}`,
        sourceKind: 'medrxiv' as const,
        title: r.title,
        abstract: r.abstract,
        url: `https://www.medrxiv.org/content/${r.doi}`,
        pubTypes: [],
        isPreprint: true,
      }));
  }

  /** v1: medRxiv full-text JATS fetch is deferred; the agent reads the abstract from search(). */
  async fullText(_sourceId: string): Promise<string | null> {
    return null;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm -F @wabi/research test -- medrxiv.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/research/src/sources/medrxiv.ts packages/research/src/sources/__tests__/medrxiv.spec.ts
git commit -m "feat(research): MedrxivTool recent-window search with local filter"
```

---

## Task 14: `relevanceGate` — cheap on-topic check (abstract)

**Files:**
- Create: `packages/research/src/agent/relevance-gate.ts`, `packages/research/src/agent/__tests__/relevance-gate.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
jest.mock('@ai-sdk/openai', () => ({ createOpenAI: jest.fn(() => jest.fn(() => ({}))) }));
jest.mock('ai', () => ({ generateText: jest.fn() }));
jest.mock('@wabi/shared', () => ({
  getProvider: jest.fn(() => ({ baseUrl: 'http://t', model: 'm', apiKey: 'k' })),
}));

import { relevanceGate } from '../relevance-gate';

describe('relevanceGate', () => {
  const { generateText } = require('ai') as { generateText: jest.Mock };
  beforeEach(() => jest.clearAllMocks());

  it('keeps an on-topic abstract', async () => {
    generateText.mockResolvedValue({ text: 'yes', usage: { totalTokens: 5 } });
    const r = await relevanceGate('Emotion regulation reduced tilt in competitive players.');
    expect(r.keep).toBe(true);
    expect(r.tokens).toBe(5);
  });

  it('drops an off-topic abstract', async () => {
    generateText.mockResolvedValue({ text: 'no', usage: { totalTokens: 4 } });
    expect((await relevanceGate('A study of knee cartilage repair.')).keep).toBe(false);
  });

  it('fails open (keep) on provider error so coverage is not silently lost', async () => {
    generateText.mockRejectedValue(new Error('timeout'));
    expect((await relevanceGate('anything')).keep).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F @wabi/research test -- relevance-gate.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getProvider } from '@wabi/shared';

export interface GateResult { keep: boolean; tokens: number }

/** Cheap relevance triage on a paper's abstract, before any full-text fetch (spec §Agent behavior).
 * Fails OPEN: on error we keep the paper rather than silently drop a possibly-relevant one. */
export async function relevanceGate(abstract: string): Promise<GateResult> {
  try {
    const cfg = getProvider('research-triage');
    const openai = createOpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey });
    const { text, usage } = await generateText({
      model: openai(cfg.model),
      prompt:
        `Does this abstract describe a concrete behavioral or psychological coping/wellbeing ` +
        `technique that could inform a coaching strategy? Answer only "yes" or "no".\n\n` +
        `Abstract: ${abstract}`,
      maxOutputTokens: 5,
    });
    return { keep: text.trim().toLowerCase().startsWith('yes'), tokens: usage?.totalTokens ?? 0 };
  } catch {
    return { keep: true, tokens: 0 };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm -F @wabi/research test -- relevance-gate.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/research/src/agent/relevance-gate.ts packages/research/src/agent/__tests__/relevance-gate.spec.ts
git commit -m "feat(research): relevanceGate abstract triage (fail-open)"
```

---

## Task 15: `extract` + `evidenceTag` — grounded, generalized technique

Returns a generalized (audience-neutral) technique with a **verbatim** `sourceText`. Validates the quote is an actual substring of the source — a hallucinated quote → `null`, so faithfulness can't be gamed.

**Files:**
- Create: `packages/research/src/agent/extract.ts`, `packages/research/src/agent/__tests__/extract.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
jest.mock('@ai-sdk/openai', () => ({ createOpenAI: jest.fn(() => jest.fn(() => ({}))) }));
jest.mock('ai', () => ({ generateText: jest.fn() }));
jest.mock('@wabi/shared', () => ({
  getProvider: jest.fn(() => ({ baseUrl: 'http://t', model: 'm', apiKey: 'k' })),
}));

import { extract, evidenceTag } from '../extract';
import { Paper } from '../../types';

const paper: Paper = {
  sourceId: 'PMID:1', sourceKind: 'pubmed', title: 'PMR and anxiety',
  abstract: 'In this trial, progressive muscle relaxation reduced state anxiety.',
  url: 'https://pubmed.ncbi.nlm.nih.gov/1', pubTypes: ['Randomized Controlled Trial'], isPreprint: false,
};

describe('evidenceTag', () => {
  it('tags peer-reviewed study types', () => {
    expect(evidenceTag(paper)).toBe('peer-reviewed: Randomized Controlled Trial');
  });
  it('tags observational when no high-tier type present', () => {
    expect(evidenceTag({ ...paper, pubTypes: ['Journal Article'] })).toBe('peer-reviewed: observational');
  });
  it('tags preprints', () => {
    expect(evidenceTag({ ...paper, isPreprint: true, pubTypes: [] })).toBe('preprint: not peer-reviewed');
  });
});

describe('extract', () => {
  const { generateText } = require('ai') as { generateText: jest.Mock };
  beforeEach(() => jest.clearAllMocks());

  it('returns a candidate whose sourceText is a verbatim substring of the body', async () => {
    generateText.mockResolvedValue({
      text: JSON.stringify({
        title: 'Progressive muscle relaxation',
        technique: 'Tense and release the major muscle groups for several minutes to lower acute anxiety.',
        sourceText: 'progressive muscle relaxation reduced state anxiety',
      }),
      usage: { totalTokens: 50 },
    });
    const body = paper.abstract;
    const r = await extract(paper, body);
    expect(r.candidate).not.toBeNull();
    expect(body).toContain(r.candidate!.sourceText); // actual substring, not paraphrase
    expect(r.candidate!.evidence).toBe('peer-reviewed: Randomized Controlled Trial');
    expect(r.candidate!.trustLevel).toBe('research-agent');
    expect(r.candidate!.sourceId).toBe('PMID:1');
  });

  it('returns null when the quoted sourceText is not actually in the body (hallucination guard)', async () => {
    generateText.mockResolvedValue({
      text: JSON.stringify({ title: 'X', technique: 'Y', sourceText: 'a quote that is not present' }),
      usage: { totalTokens: 10 },
    });
    expect((await extract(paper, paper.abstract)).candidate).toBeNull();
  });

  it('returns null when the model declines (no clean technique)', async () => {
    generateText.mockResolvedValue({ text: 'null', usage: { totalTokens: 8 } });
    expect((await extract(paper, paper.abstract)).candidate).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F @wabi/research test -- extract.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getProvider } from '@wabi/shared';
import { Paper, Candidate } from '../types';

const HIGH_TIER = ['Meta-Analysis', 'Systematic Review', 'Randomized Controlled Trial'];

/** Evidence tag is set from the source's nature, never the model's self-claim (ADR-0012). */
export function evidenceTag(paper: Paper): string {
  if (paper.isPreprint) return 'preprint: not peer-reviewed';
  const tier = paper.pubTypes.find((t) => HIGH_TIER.includes(t));
  return tier ? `peer-reviewed: ${tier}` : 'peer-reviewed: observational';
}

export interface ExtractResult { candidate: Candidate | null; tokens: number }

/** One source body → one generalized, grounded candidate or null. The technique must be
 * audience-neutral (no game-specific framing — that's coaching-time work) and the sourceText must be
 * a VERBATIM quote, validated here as an actual substring so faithfulnessCheck can't be gamed. */
export async function extract(paper: Paper, body: string): Promise<ExtractResult> {
  const cfg = getProvider('research');
  const openai = createOpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey });

  let text = '';
  let tokens = 0;
  try {
    const out = await generateText({
      model: openai(cfg.model),
      prompt:
        `From the source below, extract ONE transferable, actionable coping/wellbeing technique, ` +
        `or return exactly "null" if there is no clean, safe, self-contained technique.\n` +
        `Rules:\n` +
        `- Write the technique in audience-neutral language. Do NOT mention games, gamers, ranked, ` +
        `tilt, or any specific population — describe the general mechanism only.\n` +
        `- "sourceText" MUST be a verbatim quote copied exactly from the source (a real substring).\n` +
        `Return JSON: {"title": string, "technique": string, "sourceText": string} or the literal null.\n\n` +
        `Source:\n${body}`,
      maxOutputTokens: 400,
    });
    text = out.text.trim();
    tokens = out.usage?.totalTokens ?? 0;
  } catch {
    return { candidate: null, tokens: 0 };
  }

  if (text.toLowerCase() === 'null') return { candidate: null, tokens };

  let parsed: { title?: string; technique?: string; sourceText?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    return { candidate: null, tokens };
  }

  const { title, technique, sourceText } = parsed;
  if (!title || !technique || !sourceText) return { candidate: null, tokens };
  // Hallucination guard: the quote must actually appear in the source body.
  if (!body.includes(sourceText)) return { candidate: null, tokens };

  return {
    candidate: {
      title,
      technique,
      sourceText,
      evidence: evidenceTag(paper),
      sourceUrl: paper.url,
      source: paper.sourceKind === 'medrxiv' ? 'medRxiv (preprint)' : 'PubMed',
      sourceId: paper.sourceId,
      sourceKind: paper.sourceKind,
      trustLevel: 'research-agent',
    },
    tokens,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm -F @wabi/research test -- extract.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/research/src/agent/extract.ts packages/research/src/agent/__tests__/extract.spec.ts
git commit -m "feat(research): extract grounded generalized technique + evidenceTag"
```

---

## Task 16: `isDuplicateInRun` — lexical prefilter + LLM confirm

**Files:**
- Create: `packages/research/src/agent/dedup.ts`, `packages/research/src/agent/__tests__/dedup.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
jest.mock('@ai-sdk/openai', () => ({ createOpenAI: jest.fn(() => jest.fn(() => ({}))) }));
jest.mock('ai', () => ({ generateText: jest.fn() }));
jest.mock('@wabi/shared', () => ({ getProvider: jest.fn(() => ({ baseUrl: 'http://t', model: 'm', apiKey: 'k' })) }));

import { isDuplicateInRun } from '../dedup';
import { Candidate } from '../../types';

const mk = (title: string, technique: string): Candidate => ({
  title, technique, sourceText: 's', evidence: 'e', sourceUrl: 'u',
  source: 'PubMed', sourceId: 'PMID:x', sourceKind: 'pubmed', trustLevel: 'research-agent',
});

describe('isDuplicateInRun', () => {
  const { generateText } = require('ai') as { generateText: jest.Mock };
  beforeEach(() => jest.clearAllMocks());

  it('distinct when there is nothing kept yet (no LLM call)', async () => {
    const r = await isDuplicateInRun(mk('Box Breathing', 'inhale hold exhale'), []);
    expect(r.duplicate).toBe(false);
    expect(generateText).not.toHaveBeenCalled();
  });

  it('duplicate via lexical overlap without an LLM call', async () => {
    const kept = [mk('Progressive muscle relaxation', 'tense and release major muscle groups')];
    const r = await isDuplicateInRun(mk('Progressive muscle relaxation', 'tense and release major muscle groups'), kept);
    expect(r.duplicate).toBe(true);
    expect(generateText).not.toHaveBeenCalled();
  });

  it('uses the LLM to confirm an ambiguous middle case', async () => {
    generateText.mockResolvedValue({ text: 'same', usage: { totalTokens: 6 } });
    const kept = [mk('Box Breathing', 'inhale 4 hold 4 exhale 4 to calm down')];
    const r = await isDuplicateInRun(mk('Square breathing drill', 'four-count breathing to reduce arousal'), kept);
    expect(generateText).toHaveBeenCalled();
    expect(r.duplicate).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F @wabi/research test -- dedup.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { getProvider } from '@wabi/shared';
import { Candidate } from '../types';

const HIGH = 0.6;  // ≥ → duplicate without asking the LLM
const LOW = 0.2;   // ≤ → distinct without asking the LLM

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
}
function jaccard(a: string, b: string): number {
  const sa = tokens(a), sb = tokens(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}
const sig = (c: Candidate) => `${c.title} ${c.technique}`;

export interface DedupResult { duplicate: boolean; tokens: number }

/** In-run technique dedup with no embeddings (those live on the bot). Lexical prefilter decides the
 * clear cases; the triage LLM only adjudicates the ambiguous middle. */
export async function isDuplicateInRun(candidate: Candidate, kept: Candidate[]): Promise<DedupResult> {
  if (kept.length === 0) return { duplicate: false, tokens: 0 };

  let best = kept[0];
  let bestSim = 0;
  for (const k of kept) {
    const s = jaccard(sig(candidate), sig(k));
    if (s > bestSim) { bestSim = s; best = k; }
  }

  if (bestSim >= HIGH) return { duplicate: true, tokens: 0 };
  if (bestSim <= LOW) return { duplicate: false, tokens: 0 };

  try {
    const cfg = getProvider('research-triage');
    const openai = createOpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey });
    const { text, usage } = await generateText({
      model: openai(cfg.model),
      prompt:
        `Are these two coaching techniques essentially the same? Answer only "same" or "different".\n` +
        `A: ${sig(candidate)}\nB: ${sig(best)}`,
      maxOutputTokens: 5,
    });
    return { duplicate: text.trim().toLowerCase().startsWith('same'), tokens: usage?.totalTokens ?? 0 };
  } catch {
    return { duplicate: false, tokens: 0 }; // fail-open: keep, the bot's library dedup is the backstop
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm -F @wabi/research test -- dedup.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/research/src/agent/dedup.ts packages/research/src/agent/__tests__/dedup.spec.ts
git commit -m "feat(research): in-run technique dedup (lexical prefilter + LLM confirm)"
```

---

## Task 17: `BotClient` — `seen` + `submit`

**Files:**
- Create: `packages/research/src/bot-client.ts`, `packages/research/src/__tests__/bot-client.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { BotClient } from '../bot-client';

const candidate = {
  title: 't', technique: 'q', sourceText: 's', evidence: 'e', sourceUrl: 'u',
  source: 'PubMed', sourceId: 'PMID:1', sourceKind: 'pubmed' as const, trustLevel: 'research-agent' as const,
};

describe('BotClient', () => {
  it('seen sends the admin secret and returns the flag', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ seen: true }) });
    const client = new BotClient({ baseUrl: 'http://bot', secret: 'sek', fetchFn });
    expect(await client.seen('PMID:1')).toBe(true);
    const [url, opts] = fetchFn.mock.calls[0];
    expect(url).toContain('/admin/strategies/seen?sourceId=PMID%3A1');
    expect(opts.headers['x-admin-secret']).toBe('sek');
  });

  it('submit maps 201 → submitted', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ status: 'submitted', draftId: 'd1' }) });
    const client = new BotClient({ baseUrl: 'http://bot', secret: 'sek', fetchFn });
    expect(await client.submit(candidate)).toBe('submitted');
  });

  it('submit maps 409 → deduped', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ status: 'deduped' }) });
    const client = new BotClient({ baseUrl: 'http://bot', secret: 'sek', fetchFn });
    expect(await client.submit(candidate)).toBe('deduped');
  });

  it('submit maps other failures → error', async () => {
    const fetchFn = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const client = new BotClient({ baseUrl: 'http://bot', secret: 'sek', fetchFn });
    expect(await client.submit(candidate)).toBe('error');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F @wabi/research test -- bot-client.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { Candidate } from './types';

export interface BotClientDeps { baseUrl: string; secret: string; fetchFn?: typeof fetch }
export type SubmitOutcome = 'submitted' | 'deduped' | 'error';

/** The worker's only coupling to the bot. All store access is the bot's; this just calls its
 * authenticated endpoints (ADR-0002/0033). */
export class BotClient {
  private readonly fetchFn: typeof fetch;
  constructor(private readonly deps: BotClientDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'x-admin-secret': this.deps.secret };
  }

  async seen(sourceId: string): Promise<boolean> {
    const url = `${this.deps.baseUrl}/admin/strategies/seen?sourceId=${encodeURIComponent(sourceId)}`;
    try {
      const res = await this.fetchFn(url, { headers: this.headers() });
      if (!res.ok) return false; // on lookup failure, don't skip — let the run re-evaluate
      const body = (await res.json()) as { seen?: boolean };
      return body.seen === true;
    } catch {
      return false;
    }
  }

  async submit(candidate: Candidate): Promise<SubmitOutcome> {
    const url = `${this.deps.baseUrl}/admin/strategies/ingest`;
    try {
      const res = await this.fetchFn(url, { method: 'POST', headers: this.headers(), body: JSON.stringify(candidate) });
      if (res.status === 201 || res.ok) return 'submitted';
      if (res.status === 409) return 'deduped';
      return 'error';
    } catch {
      return 'error';
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm -F @wabi/research test -- bot-client.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/research/src/bot-client.ts packages/research/src/__tests__/bot-client.spec.ts
git commit -m "feat(research): BotClient seen + submit"
```

---

## Task 18: `ResearchAgent` — bounded orchestration per topic

Ties the units together: search → seen-skip → gate-on-abstract → (full text or abstract) → extract → in-run dedup → collect, honoring every bound and recording a `RunState` tally + stop reason. Discovery via `related()` is bounded by `maxDiscoverySteps`. All collaborators are injected so this is a pure-logic unit test (no network/LLM).

**Files:**
- Create: `packages/research/src/agent/research-agent.ts`, `packages/research/src/agent/__tests__/research-agent.spec.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { ResearchAgent, AgentDeps } from '../research-agent';
import { Bounds, Candidate, Paper } from '../../types';

const bounds: Bounds = {
  maxTopicsPerRun: 5, maxPapersPerTopic: 3, maxDiscoverySteps: 1, maxDraftsPerTopic: 2,
  maxDraftsPerRun: 10, agentTimeoutMs: 5000, runTimeoutMs: 60000, tokenBudget: 1_000_000,
};

function paper(id: string): Paper {
  return { sourceId: `PMID:${id}`, sourceKind: 'pubmed', title: `T${id}`, abstract: `A${id}`,
    url: `u${id}`, pubTypes: ['Randomized Controlled Trial'], isPreprint: false };
}
function candidate(id: string): Candidate {
  return { title: `Tech ${id}`, technique: `do ${id}`, sourceText: `A${id}`, evidence: 'peer-reviewed: RCT',
    sourceUrl: `u${id}`, source: 'PubMed', sourceId: `PMID:${id}`, sourceKind: 'pubmed', trustLevel: 'research-agent' };
}

function baseDeps(over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    pubmed: {
      search: jest.fn().mockResolvedValue(['1', '2', '3']),
      summary: jest.fn().mockImplementation((id: string) => Promise.resolve({ title: `T${id}`, pubTypes: ['Randomized Controlled Trial'] })),
      abstract: jest.fn().mockImplementation((id: string) => Promise.resolve(`A${id}`)),
      related: jest.fn().mockResolvedValue([]),
      fullText: jest.fn().mockResolvedValue(null),
    } as any,
    medrxiv: { search: jest.fn().mockResolvedValue([]), fullText: jest.fn().mockResolvedValue(null) } as any,
    seen: jest.fn().mockResolvedValue(false),
    gate: jest.fn().mockResolvedValue({ keep: true, tokens: 1 }),
    extract: jest.fn().mockImplementation((p: Paper) => Promise.resolve({ candidate: candidate(p.sourceId.replace('PMID:', '')), tokens: 10 })),
    dedup: jest.fn().mockResolvedValue({ duplicate: false, tokens: 0 }),
    ...over,
  };
}

describe('ResearchAgent', () => {
  it('collects distinct candidates up to maxDraftsPerTopic', async () => {
    const agent = new ResearchAgent(baseDeps(), bounds);
    const { candidates, summary } = await agent.run('topic');
    expect(candidates).toHaveLength(2);            // capped by maxDraftsPerTopic
    expect(summary.collected).toBe(2);
    expect(summary.stopReason).toBe('maxDraftsPerTopic');
  });

  it('skips papers already seen, before gate/extract', async () => {
    const deps = baseDeps({ seen: jest.fn().mockResolvedValue(true) });
    const agent = new ResearchAgent(deps, bounds);
    const { candidates, summary } = await agent.run('topic');
    expect(candidates).toHaveLength(0);
    expect(summary.seenSkipped).toBe(3);
    expect(deps.gate).not.toHaveBeenCalled();
    expect(deps.extract).not.toHaveBeenCalled();
  });

  it('does not re-call seen for a paper already visited via discovery (in-memory set)', async () => {
    const deps = baseDeps({
      pubmed: { ...baseDeps().pubmed,
        search: jest.fn().mockResolvedValue(['1']),
        related: jest.fn().mockResolvedValue(['1']),  // related loops back to 1
      } as any,
    });
    const agent = new ResearchAgent(deps, { ...bounds, maxPapersPerTopic: 5, maxDraftsPerTopic: 5 });
    await agent.run('topic');
    expect((deps.seen as jest.Mock).mock.calls.filter((c) => c[0] === 'PMID:1')).toHaveLength(1);
  });

  it('drops in-run duplicates and keeps reading for a novel one', async () => {
    const deps = baseDeps({
      dedup: jest.fn()
        .mockResolvedValueOnce({ duplicate: false, tokens: 0 })  // paper 1 kept
        .mockResolvedValueOnce({ duplicate: true, tokens: 0 })   // paper 2 dropped
        .mockResolvedValueOnce({ duplicate: false, tokens: 0 }), // paper 3 kept
    });
    const agent = new ResearchAgent(deps, bounds);
    const { candidates, summary } = await agent.run('topic');
    expect(candidates).toHaveLength(2);
    expect(summary.inRunDeduped).toBe(1);
  });

  it('continues when one paper errors (fail-open-empty)', async () => {
    const deps = baseDeps({
      extract: jest.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockImplementation((p: Paper) => Promise.resolve({ candidate: candidate(p.sourceId.replace('PMID:', '')), tokens: 10 })),
    });
    const agent = new ResearchAgent(deps, bounds);
    const { summary } = await agent.run('topic');
    expect(summary.errors).toBe(1);
    expect(summary.collected).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F @wabi/research test -- research-agent.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { Bounds, Candidate, Paper, RunSummary, SourceKind } from '../types';

export interface PubMedLike {
  search(query: string, limit: number): Promise<string[]>;
  summary(pmid: string): Promise<{ title: string; pubTypes: string[] }>;
  abstract(pmid: string): Promise<string>;
  related(pmid: string): Promise<string[]>;
  fullText(pmid: string): Promise<string | null>;
}
export interface MedrxivLike {
  search(query: string, limit: number): Promise<Paper[]>;
  fullText(sourceId: string): Promise<string | null>;
}
export interface AgentDeps {
  pubmed: PubMedLike;
  medrxiv: MedrxivLike;
  seen: (sourceId: string) => Promise<boolean>;
  gate: (abstract: string) => Promise<{ keep: boolean; tokens: number }>;
  extract: (paper: Paper, body: string) => Promise<{ candidate: Candidate | null; tokens: number }>;
  dedup: (candidate: Candidate, kept: Candidate[]) => Promise<{ duplicate: boolean; tokens: number }>;
}

function emptySummary(): RunSummary {
  return { searched: 0, seenSkipped: 0, gatedOut: 0, extracted: 0, inRunDeduped: 0,
    collected: 0, submitted: 0, libDeduped: 0, errors: 0, stopReason: 'exhausted' };
}

export class ResearchAgent {
  public tokens = 0;
  constructor(private readonly deps: AgentDeps, private readonly bounds: Bounds) {}

  async run(topic: string): Promise<{ candidates: Candidate[]; summary: RunSummary }> {
    const summary = emptySummary();
    const kept: Candidate[] = [];
    const visited = new Set<string>();     // in-memory, within-run only (avoids re-calling seen)
    const deadline = Date.now() + this.bounds.agentTimeoutMs;

    // SEARCH both sources. PubMed yields PMIDs (assembled lazily); medRxiv yields full Papers.
    const pmids = await this.deps.pubmed.search(topic, this.bounds.maxPapersPerTopic).catch(() => []);
    const medPapers = await this.deps.medrxiv.search(topic, this.bounds.maxPapersPerTopic).catch(() => []);
    const queue: Array<{ kind: SourceKind; id: string; paper?: Paper }> = [
      ...pmids.map((id) => ({ kind: 'pubmed' as const, id })),
      ...medPapers.map((p) => ({ kind: 'medrxiv' as const, id: p.sourceId, paper: p })),
    ];
    summary.searched = queue.length;

    let papersRead = 0;
    let discoverySteps = 0;

    while (queue.length > 0) {
      if (kept.length >= this.bounds.maxDraftsPerTopic) { summary.stopReason = 'maxDraftsPerTopic'; break; }
      if (papersRead >= this.bounds.maxPapersPerTopic) { summary.stopReason = 'maxPapersPerTopic'; break; }
      if (Date.now() > deadline) { summary.stopReason = 'agentTimeout'; break; }
      if (this.tokens >= this.bounds.tokenBudget) { summary.stopReason = 'tokenBudget'; break; }

      const item = queue.shift()!;
      if (visited.has(item.id)) continue;
      visited.add(item.id);

      try {
        // SEEN — cross-run skip before any read/extract.
        if (await this.deps.seen(item.id)) { summary.seenSkipped++; continue; }

        // Assemble the Paper (PubMed needs summary+abstract; medRxiv already has them).
        let paper: Paper;
        if (item.paper) {
          paper = item.paper;
        } else {
          const pmid = item.id.replace('PMID:', '');
          const [s, abstract] = await Promise.all([
            this.deps.pubmed.summary(pmid),
            this.deps.pubmed.abstract(pmid),
          ]);
          paper = { sourceId: `PMID:${pmid}`, sourceKind: 'pubmed', title: s.title, abstract,
            url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}`, pubTypes: s.pubTypes, isPreprint: false };
        }

        // GATE on the abstract before any full-text fetch.
        const gate = await this.deps.gate(paper.abstract);
        this.tokens += gate.tokens;
        if (!gate.keep) { summary.gatedOut++; papersRead++; continue; }

        // DISCOVER — branch to related papers (PubMed only), bounded.
        if (paper.sourceKind === 'pubmed' && discoverySteps < this.bounds.maxDiscoverySteps) {
          discoverySteps++;
          const related = await this.deps.pubmed.related(paper.sourceId.replace('PMID:', '')).catch(() => []);
          for (const rid of related) {
            const sid = `PMID:${rid}`;
            if (!visited.has(sid)) queue.push({ kind: 'pubmed', id: sid });
          }
        }

        // READ — full text when freely available, else the abstract.
        const full = paper.sourceKind === 'pubmed'
          ? await this.deps.pubmed.fullText(paper.sourceId.replace('PMID:', '')).catch(() => null)
          : await this.deps.medrxiv.fullText(paper.sourceId).catch(() => null);
        const body = full ?? paper.abstract;
        papersRead++;

        // EXTRACT.
        const { candidate, tokens } = await this.deps.extract(paper, body);
        this.tokens += tokens;
        if (!candidate) continue;
        summary.extracted++;

        // IN-RUN DEDUP.
        const dd = await this.deps.dedup(candidate, kept);
        this.tokens += dd.tokens;
        if (dd.duplicate) { summary.inRunDeduped++; continue; }

        kept.push(candidate);
        summary.collected++;
      } catch {
        summary.errors++;
        continue; // fail-open-empty: one bad paper never aborts the topic
      }
    }

    return { candidates: kept, summary };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm -F @wabi/research test -- research-agent.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/research/src/agent/research-agent.ts packages/research/src/agent/__tests__/research-agent.spec.ts
git commit -m "feat(research): ResearchAgent bounded per-topic orchestration"
```

---

## Task 19: `run.ts` — entrypoint, run budget, summary

Loops topics under `maxTopicsPerRun` / `maxDraftsPerRun` / `runTimeoutMs` / token budget, submits via `BotClient`, prints the run summary. A `runResearch(deps)` core is unit-tested; the bottom `if (require.main === module)` wires real tools and is not under test.

**Files:**
- Create: `packages/research/src/run.ts`, `packages/research/src/__tests__/run.spec.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { runResearch, RunDeps } from '../run';
import { Bounds, Candidate } from '../types';

const bounds: Bounds = {
  maxTopicsPerRun: 2, maxPapersPerTopic: 8, maxDiscoverySteps: 2, maxDraftsPerTopic: 3,
  maxDraftsPerRun: 3, agentTimeoutMs: 5000, runTimeoutMs: 60000, tokenBudget: 1_000_000,
};
const cand = (id: string): Candidate => ({
  title: `t${id}`, technique: `q${id}`, sourceText: 's', evidence: 'e', sourceUrl: 'u',
  source: 'PubMed', sourceId: `PMID:${id}`, sourceKind: 'pubmed', trustLevel: 'research-agent',
});

describe('runResearch', () => {
  it('submits collected candidates and caps at maxDraftsPerRun across topics', async () => {
    const submit = jest.fn().mockResolvedValue('submitted');
    const deps: RunDeps = {
      topics: ['a', 'b'],
      bounds,
      runAgent: jest.fn()
        .mockResolvedValueOnce({ candidates: [cand('1'), cand('2')], summary: { collected: 2 } as any, tokens: 100 })
        .mockResolvedValueOnce({ candidates: [cand('3'), cand('4')], summary: { collected: 2 } as any, tokens: 100 }),
      submit,
    };
    const result = await runResearch(deps);
    expect(submit).toHaveBeenCalledTimes(3);   // 4 collected, capped to maxDraftsPerRun=3
    expect(result.submitted).toBe(3);
  });

  it('stops processing further topics once the run draft cap is hit', async () => {
    const submit = jest.fn().mockResolvedValue('submitted');
    const runAgent = jest.fn().mockResolvedValue({ candidates: [cand('1'), cand('2'), cand('3')], summary: { collected: 3 } as any, tokens: 10 });
    const result = await runResearch({ topics: ['a', 'b'], bounds, runAgent, submit });
    expect(runAgent).toHaveBeenCalledTimes(1);  // second topic never started
    expect(result.submitted).toBe(3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F @wabi/research test -- run.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
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

// Re-exported so callers/tests can compose the real LLM-backed agent if desired.
export { createOpenAI };
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm -F @wabi/research test -- run.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full package check**

Run: `pnpm -F @wabi/research test` then `pnpm -F @wabi/research build`
Expected: all worker specs PASS; `tsc` compiles clean.

- [ ] **Step 6: Commit**

```bash
git add packages/research/src/run.ts packages/research/src/__tests__/run.spec.ts
git commit -m "feat(research): run entrypoint with run budget + summary"
```

---

## Task 20: Wire env docs + final whole-repo check

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Document worker env**

Append to `.env.example` (under the research block from Task 1): `BOT_BASE_URL=http://localhost:3001`, `NCBI_API_KEY=` (optional, raises NCBI rate cap), `RESEARCH_DEDUP_THRESHOLD=0.95`, and the bound overrides (`RESEARCH_MAX_TOPICS_PER_RUN`, `RESEARCH_MAX_PAPERS_PER_TOPIC`, `RESEARCH_MAX_DISCOVERY_STEPS`, `RESEARCH_MAX_DRAFTS_PER_TOPIC`, `RESEARCH_MAX_DRAFTS_PER_RUN`, `RESEARCH_AGENT_TIMEOUT_MS`, `RESEARCH_RUN_TIMEOUT_MS`, `RESEARCH_TOKEN_BUDGET`) each commented with its default.

- [ ] **Step 2: Whole-repo test**

Run (repo root): `pnpm test`
Expected: every package's unit specs PASS (bot, shared, research). Integration specs run separately via `pnpm -F bot test:integration` and need Docker.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "docs(research): document worker env vars"
```

---

## Self-Review (completed during authoring)

**Spec coverage** — every spec section maps to a task:
- Reading depth (B, full-text-when-free) → Task 12 `fullText` + Task 18 READ step (full ?? abstract).
- What we store (C, generalized + verbatim quote) → Task 15 `extract` (audience-neutral prompt + substring guard).
- Decision policy (rank + gate-on-abstract) → Task 14 `relevanceGate` + Task 18 gate-before-fulltext/discover.
- In-run dedup (worker LLM, no embeddings) → Task 16 + Task 18.
- Source idempotency (`ProcessedSource` + `seen`) → Tasks 4, 6, 8, 17, 18.
- Trust override (`research-agent` always queues) → Task 2 + Task 7 (forces trust level).
- Library dedup at ingest → Tasks 3, 5, 7, 9.
- Write-timing (record submit/deduped/rejected at ingest) → Task 7.
- Inference roles (capable extract, lighter triage) → Task 1 + used in Tasks 14/15/16.
- Bounds table → Task 10 `config.ts` + enforced in Tasks 18/19.
- Run summary tallies → Tasks 18/19.
- Test plan (unit + bot-side + integration) → covered per task + Task 9.

**Placeholder scan:** none — every code step is complete; the only `null`-returning stub (`MedrxivTool.fullText`) is a deliberate, documented v1 scope decision, not a TODO.

**Type consistency:** `Candidate`, `Paper`, `Bounds`, `RunSummary`, `IngestCandidate`, `ProcessedSource` field names match across worker (Tasks 10–19) and bot (Tasks 4–9); `BotClient.submit` payload (a `Candidate`) carries exactly the fields the bot's `IngestCandidate` reads (`sourceId`, `sourceKind`, `source`, `sourceText`, etc.); `seen` query param `sourceId` matches the controller.

**Note for the implementer:** Part A (Tasks 1–9) must land and pass before Part B integration is meaningful, since the worker targets those endpoints. Tasks 3 and 9 require Docker (testcontainers).
