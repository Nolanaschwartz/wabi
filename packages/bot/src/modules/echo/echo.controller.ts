import { Injectable } from '@nestjs/common';
import { Context, ContextOf, On } from 'necord';
import { CrisisScreeningService } from '../crisis/crisis-screening.service';
import { EscalationService } from '../crisis/escalation.service';
import { CoachingService } from '../coaching/coaching.service';

@Injectable()
export class EchoController {
  constructor(
    private readonly crisisScreening: CrisisScreeningService,
    private readonly escalation: EscalationService,
    private readonly coaching: CoachingService,
  ) {}

  @On('messageCreate')
  async handleMessage(
    @Context() [message]: ContextOf<'messageCreate'>,
  ): Promise<void> {
    if (message.author.bot) return;
    if (!message.channel.isDMBased()) return;

    if (this.crisisScreening.tripwire(message.content)) {
      // Cancel-on-crisis: a crisis message arriving mid-burst must kill any pending coach turn
      // for this user (e.g. a benign first message still debouncing), so no cheerful reply is
      // sent alongside the crisis resources. (Issue #06 / #25.)
      this.coaching.cancelPending(message.author.id);
      const response = await this.escalation.escalate(message.author.id, 'tripwire');
      await message.reply(response);
      return;
    }

    await this.coaching.handle(message);
  }
}
