import { lucia } from "@/lib/auth";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function middleware(request: NextRequest): Promise<NextResponse> {
	const response = NextResponse.next();

	const sessionId = request.cookies.get(lucia.sessionCookieName)?.value ?? null;
	if (!sessionId) {
		return response;
	}

	const result = await lucia.validateSession(sessionId);
	if (!result.session) {
		const sessionCookie = lucia.createBlankSessionCookie();
		response.cookies.set(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
		return response;
	}

	const { session, user } = result;
	if (session && session.fresh) {
		const sessionCookie = lucia.createSessionCookie(session.id);
		response.cookies.set(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
	}

	if (request.nextUrl.pathname.startsWith('/dashboard')) {
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
