import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

/**
 * Guards the research-admin endpoints with a shared secret. The web `/api/admin`
 * proxy (itself operator-gated by the Next middleware) forwards the secret in the
 * `x-admin-secret` header; the browser never sees it. Fails closed: if
 * ADMIN_API_SECRET is unset, every request is rejected.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const secret = process.env.ADMIN_API_SECRET;
    if (!secret) {
      return false;
    }

    const request = context.switchToHttp().getRequest();
    const provided = request?.headers?.['x-admin-secret'];
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
