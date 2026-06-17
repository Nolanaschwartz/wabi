import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

/**
 * Guards the internal data-rights HTTP endpoints with a shared secret. The web `/api/account/*`
 * routes (each gated by the signed-in lucia session) forward the secret in the
 * `x-data-rights-secret` header on behalf of the authenticated person; the browser never sees it.
 *
 * A secret distinct from `ADMIN_API_SECRET` on purpose: operator-admin authorisation and a
 * person's own data-rights authorisation are different trust boundaries and shouldn't share a key.
 *
 * Fails closed: if DATA_RIGHTS_API_SECRET is unset, every request is rejected.
 */
@Injectable()
export class DataRightsApiGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const secret = process.env.DATA_RIGHTS_API_SECRET;
    if (!secret) {
      return false;
    }

    const request = context.switchToHttp().getRequest();
    const provided = request?.headers?.['x-data-rights-secret'];
    if (typeof provided !== 'string' || provided.length === 0) {
      return false;
    }

    const a = Buffer.from(provided);
    const b = Buffer.from(secret);
    if (a.length !== b.length) {
      return false;
    }

    return timingSafeEqual(a, b);
  }
}
