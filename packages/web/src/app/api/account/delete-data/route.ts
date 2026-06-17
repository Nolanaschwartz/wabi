import { requireAuthenticated } from '@/lib/auth-guard';
import { callDataRightsApi } from '@/lib/data-rights-api';

/**
 * Delete the signed-in person's child data while keeping their account and subscription (the
 * Discord `/data delete` behaviour). Authenticates the lucia session and forwards the person's own
 * discordId to the bot's `DataRightsService.delete()`. A bot failure is relayed so the UI can
 * report an incomplete deletion rather than falsely confirming success (ADR-0011).
 */
export async function POST(): Promise<Response> {
  const user = await requireAuthenticated();
  if (user instanceof Response) return user;

  const res = await callDataRightsApi('delete-data', user.discordId);
  if (!res.ok) {
    return new Response('Failed to delete data', { status: res.status });
  }

  return Response.json({ ok: true });
}
