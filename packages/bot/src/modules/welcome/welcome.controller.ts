import { Injectable } from '@nestjs/common';
import { Context, ContextOf, On } from 'necord';
import { WelcomeService } from './welcome.service';

/**
 * Thin discord.js adapter: fires the welcome DM when someone joins the hub server.
 * It holds no business logic — it only filters to the configured hub guild and delegates.
 * If DISCORD_HUB_GUILD_ID is unset, the feature is inert (graceful degradation).
 */
@Injectable()
export class WelcomeController {
  constructor(private readonly welcome: WelcomeService) {}

  @On('guildMemberAdd')
  async handleGuildMemberAdd(
    @Context() [member]: ContextOf<'guildMemberAdd'>,
  ): Promise<void> {
    const hubGuildId = process.env.DISCORD_HUB_GUILD_ID;
    if (!hubGuildId || member.guild.id !== hubGuildId) return;

    await this.welcome.welcome(member.id);
  }
}
