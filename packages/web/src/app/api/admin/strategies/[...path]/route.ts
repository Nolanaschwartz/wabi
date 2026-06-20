import { createAdminProxy } from "@/lib/admin-proxy";

/**
 * Operator-only proxy to the bot's strategy-admin endpoints (shared handler in @/lib/admin-proxy).
 * The bot binds :3001 (web owns :3000); a :3000 default would forward to web itself → 404 → an empty
 * strategy list. Exposes GET + POST only — add PATCH/PUT/DELETE here if the bot's API gains them.
 */
const proxy = createAdminProxy({
	baseUrl: () => process.env.BOT_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001",
	upstreamPrefix: "admin/strategies",
});

export const GET = proxy.GET;
export const POST = proxy.POST;
