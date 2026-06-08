import { ApplicationIntegrationType, InteractionContextType } from 'discord.js';

// Wabi is a guild-installed (hub) bot delivered DM-first (ADR-0003/0015): commands must work
// both in the hub guild AND in the 1:1 DM with the bot. Discord IGNORES the legacy
// `dm_permission` flag once `integration_types` includes user-install, so DM visibility is
// controlled explicitly here via `contexts`. Without this, commands register with
// `contexts: null` and show in guilds but NOT in DMs.
//
// - Guild  (0): the hub server.
// - BotDM  (1): the 1:1 DM with Wabi — the primary surface.
// PrivateChannel (2) is intentionally omitted; it requires user-install, which this bot is not.
export const COMMAND_CONTEXTS = {
  contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
  integrationTypes: [ApplicationIntegrationType.GuildInstall],
};
