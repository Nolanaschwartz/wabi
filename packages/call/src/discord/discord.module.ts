import { Module } from '@nestjs/common';
import { NecordModule } from 'necord';
import { GatewayIntentBits } from 'discord.js';
import { AgentModule } from '../agent/agent.module';
import { CallCommands } from './call.commands';
import { DiscordBridge } from './bridge.service';

@Module({
  imports: [
    // forRootAsync so the token is read at runtime (after ConfigModule loads .env), not at import time.
    NecordModule.forRootAsync({
      useFactory: () => ({
        // Own token, distinct from the bot's DISCORD_TOKEN — two gateway logins on one token collide.
        token: process.env.CALL_DISCORD_TOKEN!,
        // GuildVoiceStates is required to see which channel you're in and to join voice.
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
        // Dev guild registers /call instantly; global commands take ~1h to propagate.
        development: process.env.CALL_DISCORD_DEV_GUILD
          ? [process.env.CALL_DISCORD_DEV_GUILD]
          : undefined,
      }),
    }),
    AgentModule,
  ],
  providers: [CallCommands, DiscordBridge],
})
export class DiscordModule {}
