import { discordAuth } from "@/lib/auth";
import { generateState } from "arctic";
import { NextResponse } from "next/server";

export async function GET(): Promise<Response> {
	const state = generateState();
	const url = await discordAuth.createAuthorizationURL(state, "identify email", [process.env.NEXT_PUBLIC_BASE_URL + "/api/auth/discord/callback"]);

	const response = NextResponse.redirect(url);
	response.cookies.set("discord_oauth_state", state, {
		secure: process.env.NODE_ENV === "production",
		httpOnly: true,
		path: "/",
		maxAge: 60 * 10,
	});

	return response;
}
