import { defaultLogger, noopLogger } from '../logger';

describe('defaultLogger', () => {
  let spy: jest.SpyInstance;
  const prev = process.env.RESEARCH_LOG_LEVEL;
  beforeEach(() => { spy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { spy.mockRestore(); if (prev === undefined) delete process.env.RESEARCH_LOG_LEVEL; else process.env.RESEARCH_LOG_LEVEL = prev; });

  it('writes progress to stderr (console.error), prefixed and with key=val meta', () => {
    process.env.RESEARCH_LOG_LEVEL = 'info';
    defaultLogger().info('paper', { id: 'PMID:1', kind: 'pubmed' });
    expect(spy).toHaveBeenCalledWith('[research] paper id=PMID:1 kind=pubmed');
  });

  it('quotes values containing spaces', () => {
    process.env.RESEARCH_LOG_LEVEL = 'info';
    defaultLogger().info('extracted', { title: 'Box Breathing Drill' });
    expect(spy).toHaveBeenCalledWith('[research] extracted title="Box Breathing Drill"');
  });

  it('suppresses debug at info level, emits it at debug level (re-read per call)', () => {
    process.env.RESEARCH_LOG_LEVEL = 'info';
    const log = defaultLogger();
    log.debug('body', { chars: 10 });
    expect(spy).not.toHaveBeenCalled();
    process.env.RESEARCH_LOG_LEVEL = 'debug';
    log.debug('body', { chars: 10 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('silent level emits nothing', () => {
    process.env.RESEARCH_LOG_LEVEL = 'silent';
    defaultLogger().info('x');
    expect(spy).not.toHaveBeenCalled();
  });

  it('noopLogger never touches the console', () => {
    noopLogger.info('x', { a: 1 });
    noopLogger.debug('y');
    expect(spy).not.toHaveBeenCalled();
  });
});
