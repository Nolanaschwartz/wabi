import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticated } from "@/lib/auth-guard";
import { isOperator } from "@/lib/admin";

/**
 * Shared operator-only proxy to a backend service's admin endpoints. The strategies (bot :3001) and
 * research (worker :3002) proxies were byte-for-byte identical apart from the target base URL and the
 * upstream path prefix; this factory is the single implementation. The Next middleware already gates
 * `/api/admin/*`; each generated handler re-checks the operator (defense in depth) and forwards with
 * the shared `x-admin-secret`, read server-side only and never exposed to the browser.
 */
type RouteContext = { params: Promise<{ path: string[] }> };

/** A denial response (401 unauthenticated / 403 non-operator), or null if the caller may proceed. */
async function operatorGate(): Promise<NextResponse | null> {
	const user = await requireAuthenticated();
	if (user instanceof Response) {
		return new NextResponse(user.body, {
			status: user.status,
			headers: user.headers as HeadersInit,
		});
	}
	if (!isOperator((user as { discordId?: string }).discordId)) {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
	return null;
}

export interface AdminProxyOptions {
	/** Resolved lazily per request so the env var is read server-side at call time, never frozen. */
	baseUrl: () => string;
	/** Upstream path prefix appended to baseUrl, e.g. "admin/strategies" or "admin/research". */
	upstreamPrefix: string;
}

/**
 * Build a set of Next route handlers (GET/POST/PATCH/PUT/DELETE) that gate on operator then forward to
 * the backend. A route.ts re-exports only the verbs the backend actually supports — Next registers just
 * the exported ones, so omitting a verb keeps that method 405.
 */
export function createAdminProxy(opts: AdminProxyOptions) {
	async function forward(method: string, segments: string[], body?: unknown): Promise<NextResponse> {
		const url = `${opts.baseUrl()}/${opts.upstreamPrefix}/${segments.join("/")}`;
		const res = await fetch(url, {
			method,
			headers: {
				"Content-Type": "application/json",
				"x-admin-secret": process.env.ADMIN_API_SECRET ?? "",
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});

		const text = await res.text();
		return new NextResponse(text, {
			status: res.status,
			headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" },
		});
	}

	async function withBody(method: string, request: NextRequest, ctx: RouteContext): Promise<NextResponse> {
		const denied = await operatorGate();
		if (denied) return denied;
		const { path } = await ctx.params;
		const body = await request.json().catch(() => ({}));
		return forward(method, path, body);
	}

	async function noBody(method: string, _request: NextRequest, ctx: RouteContext): Promise<NextResponse> {
		const denied = await operatorGate();
		if (denied) return denied;
		const { path } = await ctx.params;
		return forward(method, path);
	}

	return {
		GET: (request: NextRequest, ctx: RouteContext) => noBody("GET", request, ctx),
		POST: (request: NextRequest, ctx: RouteContext) => withBody("POST", request, ctx),
		PATCH: (request: NextRequest, ctx: RouteContext) => withBody("PATCH", request, ctx),
		PUT: (request: NextRequest, ctx: RouteContext) => withBody("PUT", request, ctx),
		DELETE: (request: NextRequest, ctx: RouteContext) => noBody("DELETE", request, ctx),
	};
}
