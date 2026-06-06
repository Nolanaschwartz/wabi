import { lucia } from "@/lib/auth";
import { isOperator } from "@/lib/admin";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

function denyAdmin(request: NextRequest): NextResponse {
	if (request.nextUrl.pathname.startsWith("/api/")) {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}
	return NextResponse.redirect(new URL("/", request.url));
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
	const response = NextResponse.next();
	const path = request.nextUrl.pathname;
	const isAdminPath = path.startsWith("/admin") || path.startsWith("/api/admin");

	const sessionId = request.cookies.get(lucia.sessionCookieName)?.value ?? null;
	if (!sessionId) {
		return isAdminPath ? denyAdmin(request) : response;
	}

	const result = await lucia.validateSession(sessionId);
	if (!result.session) {
		const sessionCookie = lucia.createBlankSessionCookie();
		response.cookies.set(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
		return isAdminPath ? denyAdmin(request) : response;
	}

	const { session, user } = result;
	if (session && session.fresh) {
		const sessionCookie = lucia.createSessionCookie(session.id);
		response.cookies.set(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
	}

	if (isAdminPath && !isOperator(user.discordId)) {
		return denyAdmin(request);
	}

	if (path.startsWith('/dashboard')) {
		const { prisma } = await import('@wabi/shared');
		const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
		if (!dbUser?.consentAcceptedAt) {
			return NextResponse.redirect(new URL('/consent', request.url));
		}
	}

	return response;
}

export const config = {
	matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
