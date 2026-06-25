import { prisma } from '@wabi/shared';
import { requireAuthenticated } from '@/lib/auth-guard';
import { monthGrid, type MoodReader } from '@/lib/mood-read';

/**
 * Per-day average mood for one calendar month, for the mood calendar's prev/next
 * navigation. Authenticated only — personal-data reads are always available
 * regardless of access tier (ADR-0011), matching the dashboard itself. Data-only:
 * the client maps each average to an emoji.
 *
 * The padded fetch window, timezone, and Mood key all live in the mood-read module;
 * the timezone comes off the lucia session user (no separate User lookup).
 */
export async function GET(request: Request): Promise<Response> {
  const user = await requireAuthenticated();
  if (user instanceof Response) return user;

  const params = new URL(request.url).searchParams;
  const year = Number(params.get('year'));
  const month = Number(params.get('month'));
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  ) {
    return new Response('Invalid year or month', { status: 400 });
  }

  const days = await monthGrid(
    prisma as unknown as MoodReader,
    { discordId: user.discordId, timezone: user.timezone ?? 'UTC' },
    year,
    month,
  );
  return Response.json({ days });
}
