import { Injectable } from '@nestjs/common';
import { Context, SlashCommand, SlashCommandContext } from 'necord';
import { GuildMember } from 'discord.js';
import { DiscordBridge } from './bridge.service';
import { VoiceMemoryService } from '../agent/voice-memory.service';

@Injectable()
export class CallCommands {
  constructor(
    private readonly bridge: DiscordBridge,
    private readonly memory: VoiceMemoryService,
  ) {}

  @SlashCommand({
    name: 'call',
    description: 'Bot joins your voice channel and connects the AI agent',
  })
  async onCall(@Context() [interaction]: SlashCommandContext) {
    const channel = (interaction.member as GuildMember)?.voice?.channel;
    if (!channel) {
      return interaction.reply({
        content: 'Join a voice channel first.',
        ephemeral: true,
      });
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      // Recall once at call start (single round trip, no per-turn latency). Empty for group calls
      // (privacy gate), unknown users, or a degraded store — the agent then runs as a plain assistant.
      const memoryBlock = await this.memory.contextFor(channel);
      await this.bridge.start(channel, memoryBlock); // bridge wires Discord audio straight to the agent
      return interaction.editReply(
        `📞 Connected — talk to the assistant in \`${channel.name}\`.`,
      );
    } catch (e) {
      return interaction.editReply(
        `Failed to connect: ${(e as Error).message}`,
      );
    }
  }

  @SlashCommand({
    name: 'tone',
    description: 'Play a 1s test tone (diagnostic for the Discord audio path)',
  })
  async onTone(@Context() [interaction]: SlashCommandContext) {
    const guildId = (interaction.member as GuildMember).guild.id;
    const ok = this.bridge.playTone(guildId);
    return interaction.reply({
      content: ok ? '🔊 Tone sent.' : 'No active call — run /call first.',
      ephemeral: true,
    });
  }

  @SlashCommand({
    name: 'hangup',
    description: 'Disconnect the bot from voice',
  })
  async onHangup(@Context() [interaction]: SlashCommandContext) {
    const guildId = (interaction.member as GuildMember).guild.id;
    this.bridge.stop(guildId); // also stops the agent
    return interaction.reply({ content: '👋 Hung up.', ephemeral: true });
  }
}
