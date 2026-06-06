/**
 * Operator allowlist for the `/admin/*` surface. ADMIN_DISCORD_IDS is a
 * comma-separated list of Discord IDs permitted to curate Strategy Drafts.
 * Absent/empty → no one is an operator (fails closed).
 */
export function getOperatorIds(): string[] {
	return (process.env.ADMIN_DISCORD_IDS ?? "")
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean);
}

export function isOperator(discordId: string | null | undefined): boolean {
	if (!discordId) {
		return false;
	}
	return getOperatorIds().includes(discordId);
}
