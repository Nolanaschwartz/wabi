import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import {
  createLangfuseTracing,
  startActiveObservation,
  getActiveTraceId,
  type LangfuseTracing,
} from '@wabi/shared/otel';
import { LangfuseTracer } from '../langfuse-tracer.service';

// The OTEL export plane (ADR-0038): above-gate spans become real Langfuse spans, and a crisis turn is
// dropped ENTIRELY at export (root + children) by the trace-id-keyed shouldExportSpan backstop
// (ADR-0021/0024). These are integration-style: real provider + real LangfuseSpanProcessor + the
// tracer's real crisis closure, observed through an in-memory exporter — not the closure in isolation.
describe('LangfuseTracer — OTEL crisis backstop + above-gate spans', () => {
  const savedEnv = { ...process.env };
  let tracer: LangfuseTracer;
  let exporter: InMemorySpanExporter;
  let tracing: LangfuseTracing;

  beforeEach(() => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
    process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
    process.env.LANGFUSE_HOST = 'http://localhost:3999'; // self-hosted base url gates the exporter
    tracer = new LangfuseTracer();
    exporter = new InMemorySpanExporter();
    tracing = createLangfuseTracing({
      serviceName: 'wabi-bot-test',
      sampleRate: 1, // isolate the crisis drop from head sampling
      shouldExportSpan: tracer.shouldExportSpan,
      exporter,
    });
  });

  afterEach(async () => {
    await tracing.shutdown(200);
    process.env = { ...savedEnv };
  });

  const exported = (): ReadableSpan[] => exporter.getFinishedSpans();
  const names = (): string[] => exported().map((s) => s.name);

  async function turn(fn: (traceId: string) => void): Promise<void> {
    await startActiveObservation('turn', async () => {
      const traceId = getActiveTraceId() as string;
      fn(traceId);
    });
    await tracing.forceFlush();
  }

  it('drops the entire crisis trace (root + children) at export in production', async () => {
    process.env.NODE_ENV = 'production';
    await turn((traceId) => {
      tracer.latchCrisis(traceId); // synchronous, at the crisis verdict — before any span ends
      tracer.traceObservation({ name: 'classify', input: 'verbatim crisis', output: 'crisis', kind: 'generation' });
    });
    expect(names()).toEqual([]);
  });

  it('exports a safe turn with classify/intent/retrieval children nested under the turn root', async () => {
    process.env.NODE_ENV = 'production';
    await turn(() => {
      tracer.traceObservation({ name: 'classify', input: 'hi', output: 'safe', kind: 'generation', latencyMs: 5 });
      tracer.traceObservation({ name: 'intent', input: 'hi', output: 'coach', kind: 'generation', confidence: 0.7 });
      tracer.traceObservation({ name: 'retrieval', input: '', output: '', kind: 'span', metadata: { count: 2 } });
    });
    expect(names().sort()).toEqual(['classify', 'intent', 'retrieval', 'turn']);
    // Children share the turn's trace id (one tree).
    const traceIds = new Set(exported().map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);
  });

  it('retains crisis traces outside production (local full fidelity) for classifier debugging', async () => {
    delete process.env.NODE_ENV;
    await turn((traceId) => {
      tracer.latchCrisis(traceId);
      tracer.traceObservation({ name: 'classify', input: 'verbatim crisis', output: 'crisis', kind: 'generation' });
    });
    expect(names().sort()).toEqual(['classify', 'turn']);
  });

  it('does not drop a different, non-crisis turn after a crisis turn was latched (prod)', async () => {
    process.env.NODE_ENV = 'production';
    await turn((traceId) => {
      tracer.latchCrisis(traceId);
      tracer.traceObservation({ name: 'classify', input: 'x', output: 'crisis', kind: 'generation' });
    });
    expect(names()).toEqual([]);

    await turn(() => {
      tracer.traceObservation({ name: 'classify', input: 'y', output: 'safe', kind: 'generation' });
    });
    expect(names().sort()).toEqual(['classify', 'turn']);
  });

  it('shouldExportSpan composes with isDefaultExportSpan: non-Langfuse/non-GenAI spans are filtered out', () => {
    const nonLangfuse = {
      instrumentationScope: { name: 'some-other-lib' },
      attributes: {},
      spanContext: () => ({ traceId: 'abc' }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(tracer.shouldExportSpan({ otelSpan: nonLangfuse as any })).toBe(false);
  });

  it('bounds the crisis latch set with FIFO eviction at MAX_CRISIS_TURNS', () => {
    tracer.latchCrisis('first');
    expect(tracer.isCrisisLatched('first')).toBe(true);
    for (let i = 0; i < 10000; i++) tracer.latchCrisis(`id-${i}`);
    expect(tracer.isCrisisLatched('first')).toBe(false); // evicted as oldest
  });

  it('traceObservation never throws (fail-open)', () => {
    expect(() =>
      tracer.traceObservation({ name: 'classify', input: 'i', output: 'o', kind: 'generation' }),
    ).not.toThrow();
  });
});
