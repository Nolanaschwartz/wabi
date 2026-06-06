import { NextRequest, NextResponse } from "next/server";
import { validateRequest } from "@/lib/session";
import { isOperator } from "@/lib/admin";

/**
 * Operator-only proxy to the bot's strategy-admin endpoints. The Next middleware
 * already gates `/api/admin/*`; this handler re-checks the operator (defense in
 * depth) and forwards to the bot with the shared `x-admin-secret`. The secret is
 * read server-side only and never reaches the browser.
 */
function botBaseUrl(): string {
	return process.env.BOT_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";
}

async function requireOperator(): Promise<boolean> {
	const { user } = await validateRequest();
	return isOperator((user as { discordId?: string } | null)?.discordId);
}

async function forward(method: string, segments: string[], body?: unknown): Promise<NextResponse> {
	const url = `${botBaseUrl()}/admin/strategies/${segments.join("/")}`;
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
	if (!(await requireOperator())) {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
	const { path } = await params;
	return forward("GET", path);
}

export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
	if (!(await requireOperator())) {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
	const { path } = await params;
	const body = await request.json().catch(() => ({}));
	return forward("POST", path, body);
}
