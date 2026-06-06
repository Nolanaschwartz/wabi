import { ExecutionContext } from '@nestjs/common';
import { AdminGuard } from '../admin.guard';

function contextWithHeaders(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as any;
}

describe('AdminGuard', () => {
  let guard: AdminGuard;

  beforeEach(() => {
    guard = new AdminGuard();
  });

  afterEach(() => {
    delete process.env.ADMIN_API_SECRET;
  });

  it('fails closed when ADMIN_API_SECRET is unset', () => {
    delete process.env.ADMIN_API_SECRET;
    expect(guard.canActivate(contextWithHeaders({ 'x-admin-secret': 'anything' }))).toBe(false);
  });

  it('rejects a request with no secret header', () => {
    process.env.ADMIN_API_SECRET = 'shhh';
    expect(guard.canActivate(contextWithHeaders({}))).toBe(false);
  });

  it('rejects a request with the wrong secret', () => {
    process.env.ADMIN_API_SECRET = 'shhh';
    expect(guard.canActivate(contextWithHeaders({ 'x-admin-secret': 'nope' }))).toBe(false);
  });

  it('accepts a request with the matching secret', () => {
    process.env.ADMIN_API_SECRET = 'shhh';
    expect(guard.canActivate(contextWithHeaders({ 'x-admin-secret': 'shhh' }))).toBe(true);
  });
});
