import { requireAuthenticated } from '@/lib/auth-guard';
import { callDataRightsApi } from '@/lib/data-rights-api';

/**
 * Export the signed-in person's data as a downloadable JSON file. The web never reads the stores
 * itself: it authenticates the lucia session and forwards the person's own discordId to the bot's
 * `DataRightsService.export()` (the single export authority, incl. Mem0-derived memory). Always
 * available regardless of access tier — a right, never gated (ADR-0011).
 */
export async function POST(): Promise<Response> {
  const user = await requireAuthenticated();
  if (user instanceof Response) return user;

  const res = await callDataRightsApi('export', user.discordId);
  if (!res.ok) {
    return new Response('Failed to export data', { status: res.status });
  }

  const { data } = (await res.json()) as { data: string };
  return new Response(data, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="wabi-data-export.json"',
    },
  });
}
