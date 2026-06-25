import { discordAuth } from "@/lib/auth";
import { establishSession } from "@/lib/session";
import { resolveOrPend, type OnboardingWriter } from "@/lib/onboarding";
import {
	PENDING_CONSENT_COOKIE,
	PENDING_CONSENT_COOKIE_OPTIONS,
} from "@/lib/pending-consent";
import { OAuth2RequestError } from "arctic";
import { NextRequest, NextResponse } from "next/server";

/**
 * Thin adapter over the onboarding module. This route owns only the OAuth transport —
 * the state check, the code exchange, and the Discord `/@me` fetch — then hands a
 * verified identity to `resolveOrPend`. The module decides existing-vs-new and never
 * touches Discord HTTP, so its tests need no `global.fetch`. Session cookies go through
 * `establishSession`; the pending-consent path persists nothing (ADR-0002/0015).
 */
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
		const resolution = await resolveOrPend(
			prisma as unknown as OnboardingWriter,
			{ discordId: discordUser.id, email: discordUser.email ?? null },
			new Date(),
		);

		if (resolution.kind === "existing") {
			const response = NextResponse.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/dashboard`);
			await establishSession(resolution.userId, response);
			return response;
		}

		// New identity: nothing persisted yet. Hold the signed pending-consent token in an
		// httpOnly cookie; the first-ever User.create happens on the consent POST.
		const response = NextResponse.redirect(`${process.env.NEXT_PUBLIC_BASE_URL}/consent`);
		response.cookies.set(PENDING_CONSENT_COOKIE, resolution.token, PENDING_CONSENT_COOKIE_OPTIONS);
		return response;
	} catch (e) {
		console.error("[oauth:callback] error:", e);
		if (e instanceof OAuth2RequestError) {
			return new Response(null, { status: 400 });
		}
		return new Response(null, { status: 500 });
	}
}
