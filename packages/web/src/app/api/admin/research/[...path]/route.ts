import { createAdminProxy } from "@/lib/admin-proxy";

/**
 * Operator-only proxy to the research worker's admin endpoints (ADR-0034), via the shared handler in
 * @/lib/admin-proxy. Targets RESEARCH_API_URL (worker :3002). Exposes the full verb set the worker
 * admin API supports.
 */
const proxy = createAdminProxy({
	baseUrl: () => process.env.RESEARCH_API_URL || "http://localhost:3002",
	upstreamPrefix: "admin/research",
});

export const GET = proxy.GET;
export const POST = proxy.POST;
export const PATCH = proxy.PATCH;
export const PUT = proxy.PUT;
export const DELETE = proxy.DELETE;
