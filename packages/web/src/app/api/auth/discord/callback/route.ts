import { discordAuth, lucia } from "@/lib/auth";
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
		const tokens = await discordAuth.validateAuthorizationCode(code, process.env.NEXT_PUBLIC_BASE_URL + "/api/auth/discord/callback");
		const discordUserRes = await fetch("https://discord.com/api/users/@me", {
			headers: {
				Authorization: `Bearer ${tokens.accessToken}`,
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
			const response = NextResponse.redirect("/");
			response.cookies.set(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);
			return response;
		}

		const trialEndsAt = new Date(Date.now() + parseInt(process.env.TRIAL_DAYS || "7") * 24 * 60 * 60 * 1000);

		const newUser = await prisma.user.create({
			data: {
				discordId: discordUser.id,
				email: discordUser.email,
				consentAcceptedAt: new Date(),
				trialEndsAt,
				subscriptionStatus: "trialing",
			},
		});

		const session = await lucia.createSession(newUser.id, {});
		const sessionCookie = lucia.createSessionCookie(session.id);
		const response = NextResponse.redirect("/");
		response.cookies.set(sessionCookie.name, sessionCookie.value, sessionCookie.attributes);

		return response;
	} catch (e) {
		if (e instanceof OAuth2RequestError) {
			return new Response(null, { status: 400 });
		}
		return new Response(null, { status: 500 });
	}
}
