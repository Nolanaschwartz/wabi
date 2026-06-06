import { lucia } from "@/lib/auth";
import { cookies } from "next/headers";
import { cache } from "react";
import type { Session, User } from "lucia";

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
