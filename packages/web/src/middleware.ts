import { lucia } from "@/lib/auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function middleware(request: NextRequest): Promise<NextResponse> {
	const response = NextResponse.next();

	const sessionId = request.cookies.get(lucia.sessionCookieName)?.value ?? null;
	if (!sessionId) {
		return response;
	}

	const { session } = await lucia.validateSession(sessionId);
	if (session && session.fresh) {
		const sessionCookie = lucia.createSessionCookie(session.id);
		response.cookies.set(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
	}
	if (!session) {
		const sessionCookie = lucia.createBlankSessionCookie();
		response.cookies.set(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
	}

	return response;
}

export const config = {
	matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
