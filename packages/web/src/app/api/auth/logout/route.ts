import { lucia } from "@/lib/auth";
import { clearSession } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<Response> {
	const sessionId = request.cookies.get(lucia.sessionCookieName)?.value ?? null;
	if (!sessionId) {
		return new Response(null, { status: 400 });
	}

	await lucia.invalidateSession(sessionId);
	const response = NextResponse.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/`);
	clearSession(response);

	return response;
}
