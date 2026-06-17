/**
 * Resolve the bot's base URL. The bot binds :3001 (web owns :3000); a :3000 default would forward
 * to web itself. Mirrors the strategy-admin proxy's resolution.
 */
export function botBaseUrl(): string {
  return (
    process.env.BOT_API_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    'http://localhost:3001'
  );
}

/**
 * Call an internal bot data-rights endpoint on behalf of a signed-in person, carrying the shared
 * secret in the `x-data-rights-secret` header (read server-side only; never reaches the browser).
 * The web routes that use this are each gated by the lucia session and only ever pass the
 * authenticated person's own discordId.
 */
export function callDataRightsApi(
  action: 'export' | 'delete-data' | 'delete',
  discordId: string,
): Promise<Response> {
  return fetch(`${botBaseUrl()}/internal/data-rights/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-data-rights-secret': process.env.DATA_RIGHTS_API_SECRET ?? '',
    },
    body: JSON.stringify({ discordId }),
  });
}
