import { lucia } from "@/lib/auth";
import { cookies } from "next/headers";
import { cache } from "react";
import type { Session, User } from "lucia";
import type { NextResponse } from "next/server";

/**
 * Session-cookie verbs — the one place the lucia session-cookie ritual lives. Callers
 * (the onboarding flow, logout, account delete) say "establish/clear a session on this
 * response" instead of hand-rolling createSession + createSessionCookie + cookies.set.
 */
export async function establishSession(userId: string, res: NextResponse): Promise<void> {
	const session = await lucia.createSession(userId, {});
	const cookie = lucia.createSessionCookie(session.id);
	res.cookies.set(cookie.name, cookie.value, cookie.attributes);
}

export function clearSession(res: NextResponse): void {
	const cookie = lucia.createBlankSessionCookie();
	res.cookies.set(cookie.name, cookie.value, cookie.attributes);
}

export const validateRequest = cache(
	async (): Promise<{ user: User; session: Session } | { user: null; session: null }> => {
		const sessionId = (await cookies()).get(lucia.sessionCookieName)?.value ?? null;
		if (!sessionId) {
			return {
				user: null,
				session: null,
			};
		}

		const result = await lucia.validateSession(sessionId);
		return result;
	}
);
