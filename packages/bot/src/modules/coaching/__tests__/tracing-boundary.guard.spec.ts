import { generate } from '@wabi/shared/generate';
import { ClassifierService } from '../../crisis/classifier.service';
import { IntentRouterService } from '../../intent-router/intent-router.service';
import { CoachService } from '../coach.service';

jest.mock('@wabi/shared/generate', () => ({ generate: jest.fn() }));

// The ADR-0038 boundary invariant: NO AI-SDK auto-instrumentation above the synchronous crisis gate.
// The pre-verdict classifier and intent-router both touch raw user text, so their `generate` calls must
// carry no telemetry. Only the below-gate coach call enables it, routed to the isolated tracer. This
// guard locks that at the one seam they all share — `generate`'s telemetry option.
describe('tracing boundary guard (ADR-0038)', () => {
  const ISOLATED_TRACER = { __isolated: true } as any;

  beforeEach(() => {
    (generate as jest.Mock).mockResolvedValue({ text: 'safe', usage: undefined, model: 'm', latencyMs: 1 });
  });

  afterEach(() => jest.clearAllMocks());

  const optsFor = (role: string) =>
    (generate as jest.Mock).mock.calls.filter((c) => c[0] === role).map((c) => c[1]);

  it('invokes the above-gate classifier and router WITHOUT telemetry', async () => {
    await new ClassifierService().classify('i keep tilting');
    await new IntentRouterService().route('i keep tilting', [] as any);

    expect(optsFor('classifier').length).toBeGreaterThan(0);
    expect(optsFor('router').length).toBeGreaterThan(0);
    for (const opts of [...optsFor('classifier'), ...optsFor('router')]) {
      expect(opts.telemetry).toBeUndefined();
    }
  });

  it('invokes the below-gate coach generation WITH telemetry routed to the isolated tracer', async () => {
    await new CoachService().generateDetailed('system', 'prompt', {
      isEnabled: true,
      tracer: ISOLATED_TRACER,
      recordInputs: true,
      recordOutputs: true,
      functionId: 'coach',
    });

    const coachOpts = optsFor('coach');
    expect(coachOpts.length).toBeGreaterThan(0);
    for (const opts of coachOpts) {
      expect(opts.telemetry?.isEnabled).toBe(true);
      expect(opts.telemetry?.tracer).toBe(ISOLATED_TRACER);
    }
  });
});
