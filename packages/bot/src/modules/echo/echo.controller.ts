import { On } from 'necord';
import { Message } from 'discord.js';

@On('messageCreate')
export class EchoController {
  async handleEcho(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!message.channel.isDMBased()) return;

    await message.reply(`Echo: ${message.content}`);
  }
}
