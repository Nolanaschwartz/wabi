import { prisma } from '@wabi/shared';
import { requireAuthenticated } from '@/lib/auth-guard';
import { buildMonthGrid } from '@/lib/mood-series';

const DAY_MS = 86_400_000;

/**
 * Per-day average mood for one calendar month, for the mood calendar's prev/next
 * navigation. Authenticated only — personal-data reads are always available
 * regardless of access tier (ADR-0011), matching the dashboard itself. Data-only:
 * the client maps each average to an emoji.
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

  const timezone = (await prisma.user.findUnique({ where: { id: user.id } }))?.timezone ?? 'UTC';

  // Fetch the month's rows padded one day on each edge so timezone bucketing at the
  // month boundary can never drop a valid local day; buildMonthGrid does the exact
  // local-day attribution.
  const gte = new Date(Date.UTC(year, month - 1, 1) - DAY_MS);
  const lt = new Date(Date.UTC(year, month, 1) + DAY_MS);
  const moods = await prisma.mood.findMany({
    where: { userId: user.discordId, createdAt: { gte, lt } },
    select: { rating: true, createdAt: true },
  });

  const days = buildMonthGrid(moods, timezone, year, month);
  return Response.json({ days });
}
