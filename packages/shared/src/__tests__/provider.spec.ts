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

  it('falls back research to the COACH env when RESEARCH_* is unset (local setup ergonomics)', () => {
    delete process.env.RESEARCH_BASE_URL;
    delete process.env.RESEARCH_MODEL;
    delete process.env.RESEARCH_API_KEY;
    process.env.COACH_BASE_URL = 'http://coach.local/v1';
    process.env.COACH_MODEL = 'coach-model';
    process.env.COACH_API_KEY = 'ck';
    const cfg = getProvider('research');
    expect(cfg).toEqual({ baseUrl: 'http://coach.local/v1', model: 'coach-model', apiKey: 'ck' });
  });
});
