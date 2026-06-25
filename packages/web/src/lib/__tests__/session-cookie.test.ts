import { establishSession, clearSession } from '../session';

jest.mock('@/lib/auth', () => ({
  lucia: {
    createSession: jest.fn(async () => ({ id: 'sess1' })),
    createSessionCookie: jest.fn(() => ({
      name: 'session',
      value: 'sval',
      attributes: { path: '/' },
    })),
    createBlankSessionCookie: jest.fn(() => ({
      name: 'session',
      value: '',
      attributes: { path: '/', maxAge: 0 },
    })),
  },
}));

const { lucia } = require('@/lib/auth');

function fakeRes() {
  const set = jest.fn();
  return { res: { cookies: { set } } as any, set };
}

describe('session cookie verbs', () => {
  beforeEach(() => jest.clearAllMocks());

  it('establishSession mints a lucia session and sets its cookie on the response', async () => {
    const { res, set } = fakeRes();
    await establishSession('u1', res);
    expect(lucia.createSession).toHaveBeenCalledWith('u1', {});
    expect(set).toHaveBeenCalledWith('session', 'sval', { path: '/' });
  });

  it('clearSession sets a blank session cookie on the response', () => {
    const { res, set } = fakeRes();
    clearSession(res);
    expect(set).toHaveBeenCalledWith('session', '', { path: '/', maxAge: 0 });
  });
});
