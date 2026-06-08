import { Injectable } from '@nestjs/common';
import { Context, SlashCommand, SlashCommandContext } from 'necord';
import { MessageFlags } from 'discord.js';
import { COMMAND_CONTEXTS } from '../../lib/command-contexts';

export interface CommandHelp {
  name: string;
  description: string;
  usage: string[];
}

// Curated listing rendered by /help. Keep in sync when commands change — there is no public
// necord API to enumerate the registered command tree, so this is the single source of truth
// for the help surface (one entry per top-level slash command).
export const COMMAND_HELP: CommandHelp[] = [
  { name: 'mood', description: 'Log your mood', usage: ['/mood log rating:1-5 [note]'] },
  { name: 'feeling', description: 'Quick mood check-in', usage: ['/feeling [rating:1-5]'] },
  {
    name: 'tilt',
    description: 'Track and reset when you tilt',
    usage: ['/tilt start [trigger] [severity:1-10]', '/tilt resolve', '/tilt stats'],
  },
  {
    name: 'playtime',
    description: 'Log and track your playtime',
    usage: ['/playtime log duration:minutes [game]', '/playtime stats'],
  },
  {
    name: 'journal',
    description: 'Journal and reflect',
    usage: ['/journal prompt', '/journal write content:...'],
  },
  {
    name: 'checkins',
    description: 'Manage how I check in on you',
    usage: ['/checkins [enabled:true|false] [cadence] [timezone]'],
  },
  { name: 'profile', description: 'View your wellness profile', usage: ['/profile'] },
  {
    name: 'data',
    description: 'Export or delete your data',
    usage: ['/data export', '/data delete confirm:true'],
  },
  { name: 'help', description: 'Show this list of commands', usage: ['/help'] },
];

export function renderHelp(commands: CommandHelp[] = COMMAND_HELP): string {
  const lines: string[] = [
    '**Here to help 🌱**',
    'You can just message me any time and we can talk. These commands do specific things:',
    '',
  ];

  for (const command of commands) {
    lines.push(`**/${command.name}** — ${command.description}`);
    for (const usage of command.usage) {
      lines.push(` \`${usage}\``);
    }
  }

  return lines.join('\n');
}

@Injectable()
export class HelpController {
  @SlashCommand({ name: 'help', description: 'List everything Wabi can do', ...COMMAND_CONTEXTS })
  async execute(@Context() [interaction]: SlashCommandContext): Promise<void> {
    await interaction.reply({
      content: renderHelp(),
      flags: MessageFlags.Ephemeral,
    });
  }
}
