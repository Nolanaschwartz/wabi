// Regression for the crisis-spam bug: provider config must be resolved LAZILY (at getProvider call
// time), not captured at module-import time. The bot spawns without inference env vars in
// process.env; ConfigModule.forRoot loads the root .env LATER, during Nest bootstrap — which is
// after @wabi/shared has already been imported. If provider config is frozen at import, the
// classifier falls back to https://api.openai.com/v1 with an empty key -> 401 -> the classifier's
// fail-to-crisis catch -> a crisis alert on every message.
//
// Imported from source by relative path: provider.ts has no imports, so ts-jest transforms it
// standalone regardless of the @wabi/shared build artifact.

describe('getProvider — lazy env resolution', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('reflects env vars set AFTER the module is imported (mirrors late ConfigModule load)', () => {
    // Bot spawn: inference vars absent when @wabi/shared is first imported.
    delete process.env.CLASSIFIER_BASE_URL;
    delete process.env.CLASSIFIER_MODEL;
    delete process.env.CLASSIFIER_API_KEY;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getProvider } = require('../../../shared/src/provider');

    // ConfigModule.forRoot loads the root .env now — after import.
    process.env.CLASSIFIER_BASE_URL = 'http://192.168.1.229:11435/v1';
    process.env.CLASSIFIER_MODEL = 'qwopus-3.6-27B-mtp:latest';
    process.env.CLASSIFIER_API_KEY = 'lan-key';

    const cfg = getProvider('classifier');

    expect(cfg.baseUrl).toBe('http://192.168.1.229:11435/v1');
    expect(cfg.model).toBe('qwopus-3.6-27B-mtp:latest');
    expect(cfg.apiKey).toBe('lan-key');
  });

  it('still falls back to defaults when env is genuinely unset', () => {
    delete process.env.COACH_BASE_URL;
    delete process.env.COACH_MODEL;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getProvider } = require('../../../shared/src/provider');

    const cfg = getProvider('coach');
    expect(cfg.baseUrl).toBe('https://api.openai.com/v1');
    expect(cfg.model).toBe('gpt-4o');
  });
});
