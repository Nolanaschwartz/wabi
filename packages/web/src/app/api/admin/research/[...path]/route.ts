import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticated } from "@/lib/auth-guard";
import { isOperator } from "@/lib/admin";

/**
 * Operator-only proxy to the research worker's admin endpoints (ADR-0034). The Next middleware
 * already gates `/api/admin/*`; this handler re-checks the operator (defense in depth) and forwards
 * to the worker with the shared `x-admin-secret`. The secret is read server-side only and never
 * reaches the browser. Mirrors the strategies proxy but targets RESEARCH_API_URL.
 */
function researchBaseUrl(): string {
	return process.env.RESEARCH_API_URL || "http://localhost:3002";
}

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

async function forward(method: string, segments: string[], body?: unknown): Promise<NextResponse> {
	const url = `${researchBaseUrl()}/admin/research/${segments.join("/")}`;
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

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
	const denied = await operatorGate();
	if (denied) return denied;
	const { path } = await params;
	return forward("GET", path);
}

export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
	const denied = await operatorGate();
	if (denied) return denied;
	const { path } = await params;
	const body = await request.json().catch(() => ({}));
	return forward("POST", path, body);
}
