import { LangfuseIngest } from '../langfuse';

describe('LangfuseIngest', () => {
  let ingest: LangfuseIngest;

  beforeEach(() => {
    ingest = new LangfuseIngest();
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '',
      json: async () => ({}),
    } as unknown as Response);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.LANGFUSE_HOST;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
  });

  const enable = () => {
    process.env.LANGFUSE_HOST = 'http://localhost:3000';
    process.env.LANGFUSE_PUBLIC_KEY = 'test-public';
    process.env.LANGFUSE_SECRET_KEY = 'test-secret';
  };

  const lastCall = () => (global.fetch as jest.Mock).mock.calls[0];
  const sentBatch = () => JSON.parse(lastCall()[1]!.body as string).batch;

  // ── enabled (lazy env, never cached) ───────────────────────────────────────
  describe('enabled', () => {
    it('is false with no env', () => {
      expect(ingest.enabled).toBe(false);
    });

    it('is true once all three env vars are present', () => {
      enable();
      expect(ingest.enabled).toBe(true);
    });

    // Load-order rule: the kernel may be constructed BEFORE config populates process.env.
    // enablement must be re-read per access, never frozen at construction.
    it('becomes true when env appears AFTER construction', () => {
      const late = new LangfuseIngest();
      expect(late.enabled).toBe(false);
      enable();
      expect(late.enabled).toBe(true);
    });

    it('requires every key (missing secret => disabled)', () => {
      process.env.LANGFUSE_HOST = 'http://localhost:3000';
      process.env.LANGFUSE_PUBLIC_KEY = 'test-public';
      expect(ingest.enabled).toBe(false);
    });
  });

  // ── deterministic per-traceId sampling ──────────────────────────────────────
  describe('shouldSample', () => {
    it('always samples at rate >= 1', () => {
      expect(ingest.shouldSample('any', 1)).toBe(true);
      expect(ingest.shouldSample('any', 2)).toBe(true);
    });

    it('never samples at rate <= 0', () => {
      expect(ingest.shouldSample('any', 0)).toBe(false);
      expect(ingest.shouldSample('any', -1)).toBe(false);
    });

    it('is deterministic: same traceId => same decision', () => {
      const rate = 0.5;
      const a = ingest.shouldSample('trace-xyz', rate);
      const b = ingest.shouldSample('trace-xyz', rate);
      expect(a).toBe(b);
    });

    it('decides per traceId (binary), not by chance', () => {
      // The decision for a fixed id at a fixed rate must be stable across many evaluations.
      const decisions = new Set<boolean>();
      for (let i = 0; i < 50; i++) decisions.add(ingest.shouldSample('stable-id', 0.3));
      expect(decisions.size).toBe(1);
    });

    it('keeps roughly the configured fraction across many distinct ids', () => {
      let kept = 0;
      const n = 5000;
      for (let i = 0; i < n; i++) if (ingest.shouldSample(`id-${i}`, 0.5)) kept++;
      // Deterministic hash => stable distribution; allow a generous band.
      expect(kept / n).toBeGreaterThan(0.4);
      expect(kept / n).toBeLessThan(0.6);
    });
  });

  // ── disabled = clean no-op ──────────────────────────────────────────────────
  describe('disabled (no env)', () => {
    it('post is a no-op and never fetches', () => {
      ingest.post('span', { batch: [{ id: 'a' }] });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('flush is a no-op with nothing in flight', async () => {
      ingest.post('span', { batch: [{ id: 'a' }] });
      await expect(ingest.flush(10)).resolves.toBeUndefined();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  // ── batch envelope + auth header ────────────────────────────────────────────
  describe('post (enabled)', () => {
    it('POSTs the batch envelope to the ingestion endpoint', () => {
      enable();
      ingest.post('span', { batch: [{ id: 'a', type: 'trace-create' }] });
      expect(lastCall()[0]).toBe('http://localhost:3000/api/public/ingestion');
      expect(lastCall()[1]!.method).toBe('POST');
      expect(sentBatch()).toEqual([{ id: 'a', type: 'trace-create' }]);
    });

    it('authenticates with HTTP Basic auth (public:secret)', () => {
      enable();
      ingest.post('span', { batch: [{ id: 'a' }] });
      const headers = lastCall()[1]!.headers as Record<string, string>;
      const expected = `Basic ${Buffer.from('test-public:test-secret').toString('base64')}`;
      expect(headers.Authorization).toBe(expected);
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('swallows a rejected fetch (tracing never breaks the hot path)', async () => {
      enable();
      (global.fetch as jest.Mock).mockRejectedValue(new Error('network down'));
      expect(() => ingest.post('span', { batch: [{ id: 'a' }] })).not.toThrow();
      // The swallowed rejection must still settle cleanly via flush.
      await expect(ingest.flush(50)).resolves.toBeUndefined();
    });
  });

  // ── MAX_INFLIGHT cap ────────────────────────────────────────────────────────
  describe('in-flight cap', () => {
    it('does not retain more than MAX_INFLIGHT awaited POSTs', () => {
      enable();
      (global.fetch as jest.Mock).mockImplementation(() => new Promise<Response>(() => {}));
      const cap = LangfuseIngest.MAX_INFLIGHT;
      for (let i = 0; i < cap + 50; i++) ingest.post('span', { batch: [{ id: `${i}` }] });
      // Over the cap, POSTs still fire (fetch called for every one) but are not awaited.
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(cap + 50);
      expect(ingest.inflightSize).toBe(cap);
    });
  });

  // ── flush + deadline race ───────────────────────────────────────────────────
  describe('flush', () => {
    it('awaits an in-flight POST until it settles', async () => {
      enable();
      let resolveFetch: (v: Response) => void = () => {};
      (global.fetch as jest.Mock).mockImplementation(
        () => new Promise<Response>((res) => { resolveFetch = res; }),
      );
      ingest.post('span', { batch: [{ id: 'a' }] });

      let done = false;
      const flush = ingest.flush(5000).then(() => { done = true; });
      await Promise.resolve();
      expect(done).toBe(false);

      resolveFetch({ ok: true, text: async () => '', json: async () => ({}) } as unknown as Response);
      await flush;
      expect(done).toBe(true);
    });

    it('resolves within the timeout even if a POST never settles (deadline race)', async () => {
      enable();
      (global.fetch as jest.Mock).mockImplementation(() => new Promise<Response>(() => {}));
      ingest.post('span', { batch: [{ id: 'a' }] });
      await expect(ingest.flush(20)).resolves.toBeUndefined();
    });

    it('does not throw when an in-flight POST rejects', async () => {
      enable();
      (global.fetch as jest.Mock).mockRejectedValue(new Error('boom'));
      ingest.post('span', { batch: [{ id: 'a' }] });
      await expect(ingest.flush(50)).resolves.toBeUndefined();
    });
  });
});
