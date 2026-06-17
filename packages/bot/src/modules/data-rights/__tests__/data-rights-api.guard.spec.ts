import { ExecutionContext } from '@nestjs/common';
import { DataRightsApiGuard } from '../data-rights-api.guard';

function contextWithHeaders(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as any;
}

describe('DataRightsApiGuard', () => {
  let guard: DataRightsApiGuard;

  beforeEach(() => {
    guard = new DataRightsApiGuard();
  });

  afterEach(() => {
    delete process.env.DATA_RIGHTS_API_SECRET;
  });

  it('fails closed when DATA_RIGHTS_API_SECRET is unset', () => {
    delete process.env.DATA_RIGHTS_API_SECRET;
    expect(guard.canActivate(contextWithHeaders({ 'x-data-rights-secret': 'anything' }))).toBe(false);
  });

  it('rejects a request with no secret header', () => {
    process.env.DATA_RIGHTS_API_SECRET = 'shhh';
    expect(guard.canActivate(contextWithHeaders({}))).toBe(false);
  });

  it('rejects a request with the wrong secret', () => {
    process.env.DATA_RIGHTS_API_SECRET = 'shhh';
    expect(guard.canActivate(contextWithHeaders({ 'x-data-rights-secret': 'nope' }))).toBe(false);
  });

  it('rejects a secret of a different length without throwing', () => {
    process.env.DATA_RIGHTS_API_SECRET = 'shhh';
    expect(guard.canActivate(contextWithHeaders({ 'x-data-rights-secret': 'much-longer-secret' }))).toBe(false);
  });

  it('accepts a request with the matching secret', () => {
    process.env.DATA_RIGHTS_API_SECRET = 'shhh';
    expect(guard.canActivate(contextWithHeaders({ 'x-data-rights-secret': 'shhh' }))).toBe(true);
  });
});
