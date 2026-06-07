import { discordAuth, lucia } from "@/lib/auth";
import {
	PENDING_CONSENT_COOKIE,
	PENDING_CONSENT_COOKIE_OPTIONS,
	createPendingConsentToken,
} from "@/lib/pending-consent";
import { OAuth2RequestError } from "arctic";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const storedState = request.cookies.get("discord_oauth_state")?.value ?? null;

	if (!code || !state || !storedState || state !== storedState) {
		return new Response(null, { status: 400 });
	}

	try {
		const tokens = await discordAuth.validateAuthorizationCode(code, null);
		const discordUserRes = await fetch("https://discord.com/api/users/@me", {
			headers: {
				Authorization: `Bearer ${tokens.accessToken()}`,
			},
		});
		const discordUser = await discordUserRes.json();

		const { prisma } = await import("@wabi/shared");

		const existingUser = await prisma.user.findUnique({
			where: { discordId: discordUser.id },
		});

		if (existingUser) {
			const session = await lucia.createSession(existingUser.id, {});
			const sessionCookie = lucia.createSessionCookie(session.id);
			const response = NextResponse.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/dashboard`);
			response.cookies.set(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
			return response;
		}

		// New identity: do NOT create a User row or a session yet. GDPR Art. 9 / ADR-0009
		// require explicit consent before we persist an identifiable User, and Lucia can't
		// mint a session without one. Hold the authenticated identity in a signed, httpOnly
		// pending-consent cookie; the first-ever user.create happens on the consent POST.
		// (Issue #29.)
		const pendingToken = createPendingConsentToken(
			discordUser.id,
			discordUser.email ?? null,
			Date.now(),
		);
		const response = NextResponse.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/consent`);
		response.cookies.set(PENDING_CONSENT_COOKIE, pendingToken, PENDING_CONSENT_COOKIE_OPTIONS);

		return response;
	} catch (e) {
		console.error("[oauth:callback] error:", e);
		if (e instanceof OAuth2RequestError) {
			return new Response(null, { status: 400 });
		}
		return new Response(null, { status: 500 });
	}
}
