import { PrismaAdapter } from "@lucia-auth/adapter-prisma";
import { Lucia, TimeSpan } from "lucia";
import { Discord } from "arctic";

import { prisma } from "@wabi/shared";

const adapter = new PrismaAdapter(prisma.session, prisma.user);

export const lucia = new Lucia(adapter, {
	sessionCookie: {
		expires: false,
		attributes: {
			secure: process.env.NODE_ENV === "production",
		},
	},
	sessionExpiresIn: new TimeSpan(2, "w"),
	getUserAttributes: (attributes) => {
		return {
			discordId: attributes.discordId,
			email: attributes.email,
			// Surfaced so callers (e.g. the dashboard) read billing/timezone off the session user that
			// validateSession already loads, instead of issuing a second findUnique for the same row.
			timezone: attributes.timezone,
			trialEndsAt: attributes.trialEndsAt,
			subscriptionStatus: attributes.subscriptionStatus,
			// Personalization — surfaced for the onboarding gate (dashboard nudge) and the
			// /onboarding settings-edit prefill, off the same session row.
			locale: attributes.locale,
			improveAreas: attributes.improveAreas,
			interests: attributes.interests,
			onboardingCompletedAt: attributes.onboardingCompletedAt,
		};
	},
});

export const discordAuth = new Discord(
	process.env.DISCORD_CLIENT_ID!,
	process.env.DISCORD_CLIENT_SECRET!,
	`${process.env.NEXT_PUBLIC_BASE_URL}/api/auth/discord/callback`
);

declare module "lucia" {
	interface Register {
		Lucia: typeof lucia;
		DatabaseUserAttributes: DatabaseUserAttributes;
	}
	interface DatabaseUserAttributes {
		discordId: string;
		email: string | null;
		timezone: string;
		trialEndsAt: Date | null;
		subscriptionStatus: string;
		locale: string;
		improveAreas: string[];
		interests: string[];
		onboardingCompletedAt: Date | null;
	}
}
