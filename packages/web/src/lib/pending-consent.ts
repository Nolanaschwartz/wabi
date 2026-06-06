import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Pending-consent identity (issue #29).
 *
 * Lucia cannot mint a session without a User row, and GDPR Art. 9 / ADR-0009 forbid
 * persisting an identifiable User before explicit consent. So between the OAuth callback and
 * the affirmative consent POST we hold the authenticated identity entirely in a signed,
 * httpOnly cookie — no database write. The first-ever `user.create` happens only when the
 * user accepts. Abandoning the consent page therefore leaves nothing persisted.
 *
 * The token is HMAC-SHA256 signed with LUCIA_SECRET so a client cannot forge an identity
 * (e.g. claim someone else's Discord ID) to provision an account they don't own.
 */

export const PENDING_CONSENT_COOKIE = 'wabi_pending_consent';

// Window to complete the consent step. Long enough to read placeholder disclosure copy,
// short enough that a stale token can't be replayed much later.
const MAX_AGE_SECONDS = 60 * 15;

export const PENDING_CONSENT_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: MAX_AGE_SECONDS,
};

interface PendingConsentPayload {
  discordId: string;
  email: string | null;
  iat: number; // issued-at, epoch seconds
}

function secret(): string {
  const s = process.env.LUCIA_SECRET;
  if (!s) {
    throw new Error('LUCIA_SECRET is required to sign pending-consent tokens');
  }
  return s;
}

function sign(payloadB64: string): string {
  return createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

export function createPendingConsentToken(
  discordId: string,
  email: string | null,
  nowMs: number,
): string {
  const payload: PendingConsentPayload = {
    discordId,
    email,
    iat: Math.floor(nowMs / 1000),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Returns the verified identity, or null if the token is missing, tampered, malformed, or
 * expired. Constant-time signature comparison; never throws on bad input.
 */
export function verifyPendingConsentToken(
  token: string | undefined | null,
  nowMs: number,
): { discordId: string; email: string | null } | null {
  if (!token) return null;

  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!payloadB64 || !sig) return null;

  const expected = sign(payloadB64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: PendingConsentPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof payload.iat !== 'number' || !payload.discordId) return null;
  if (Math.floor(nowMs / 1000) - payload.iat > MAX_AGE_SECONDS) return null;

  return { discordId: payload.discordId, email: payload.email ?? null };
}
