import { lucia } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<Response> {
	const sessionId = request.cookies.get(lucia.sessionCookieName)?.value ?? null;
	if (!sessionId) {
		return new Response(null, { status: 400 });
	}

	await lucia.invalidateSession(sessionId);
	const sessionCookie = lucia.createBlankSessionCookie();
	const response = NextResponse.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/`);
	response.cookies.set(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);

	return response;
}
