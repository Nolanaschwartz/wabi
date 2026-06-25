import { Injectable, Logger } from '@nestjs/common';
import { Context, On, SlashCommand, SlashCommandContext, ContextOf } from 'necord';
import { GuildMember } from 'discord.js';
import { DiscordBridge } from './bridge.service';
import { VoiceMemoryService } from '../agent/voice-memory.service';
import { isLateJoiner } from './late-joiner';

@Injectable()
export class CallCommands {
  private readonly log = new Logger(CallCommands.name);

  constructor(
    private readonly bridge: DiscordBridge,
    private readonly memory: VoiceMemoryService,
  ) {}

  // Late-joiner privacy circuit-breaker (ADR-0043): the recall gate is a /call-time snapshot, so it can't
  // see a second human arriving mid-call. When one does while private memory is loaded, end the call
  // rather than mutate the live prompt. Memory-less calls carry no private facts and are left alone.
  @On('voiceStateUpdate')
  onVoiceStateUpdate(@Context() [oldState, newState]: ContextOf<'voiceStateUpdate'>) {
    const guildId = newState.guild?.id ?? oldState.guild?.id;
    if (!guildId) return;
    const call = this.bridge.activeCall(guildId);
    if (!call || !call.memoryLoaded) return; // no active call, or no private memory to protect

    // Decide off the member's own channel TRANSITION carried by the event — not a recount of
    // call.channel.members, whose cache can lag the join and undercount the joiner (the call would
    // wrongly stay up). The transition also self-filters mute/deafen churn (from === to), so this
    // handler does no per-event member scan.
    const member = newState.member ?? oldState.member;
    const botId = newState.client.user?.id;
    if (
      !isLateJoiner({
        memoryLoaded: call.memoryLoaded,
        joinerIsBot: member?.user.bot ?? true,
        joinerIsSelf: !!botId && member?.id === botId,
        fromChannelId: oldState.channelId,
        toChannelId: newState.channelId,
        bridgedChannelId: call.channel.id,
      })
    )
      return;

    this.log.warn(`late joiner in guild ${guildId} — ending the call to protect private memory`);
    this.bridge.stop(guildId); // cascades to agent.stop + audio teardown
    void call.channel
      .send('📞 Call ended — what Wabi remembers here is private to one person, and someone else joined.')
      .catch(() => {});
  }

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
