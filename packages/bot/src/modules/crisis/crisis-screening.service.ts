import { Injectable } from '@nestjs/common';
import { ClassifierService } from './classifier.service';
import { EscalationService, CrisisResponse } from './escalation.service';

/** The outcome of screening one piece of free-text input. */
export type ScreeningVerdict =
  | { kind: 'crisis'; response: CrisisResponse }
  | { kind: 'safe' };

@Injectable()
export class CrisisScreeningService {
  constructor(
    private readonly classifier: ClassifierService,
    private readonly escalation: EscalationService,
  ) {}

  private readonly explicitPatterns: RegExp[] = [
    /\bI don'?t want to live\b/i,
    /\bI don'?t want to be alive\b/i,
    /\bI don'?t want to wake up\b/i,
    /\bI want to die\b/i,
    /\bI want to kill myself\b/i,
    /\bsuicid/i,
    /\bending it all\b/i,
    /\bno reason to live\b/i,
    /\bI'?m better off dead\b/i,
    /\bI'?m going to hurt myself\b/i,
    /\bI'?m going to kill myself\b/i,
    /\bsay goodbye\b/i,
    /\bI can'?t go on\b/i,
    /\bthere'?s no point\b/i,
    /\bI want to end this\b/i,
    /\bI'?m going to end it\b/i,
    /\bI wish I were dead\b/i,
    /\bI want to go to sleep and never wake up\b/i,
    /\bI can'?t do this anymore\b/i,
    /\bI'?m so tired of living\b/i,
    /\bI'?m going to jump\b/i,
    /\bI have a plan to kill myself\b/i,
    /\bI want to overdose\b/i,
    /\bI want to slit my wrists\b/i,
    /\bI'?m going to hang myself\b/i,
  ];

  tripwire(text: string): boolean {
    const lowerText = text.toLowerCase();
    for (const pattern of this.explicitPatterns) {
      if (pattern.test(lowerText)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Full screening for one piece of a person's free-text input from any atomic surface — a Journal
   * Entry, a Mood note, a Tilt trigger (ADR-0028). Runs the two crisis-detection layers cheap-first
   * (tripwire then classifier) and, on a hit, performs a Crisis Escalation that surfaces resources +
   * records one Escalation Event but does NOT open the DM-session aftermath window (a logged field is
   * not a Conversation, so `startAftermath: false`). Returns the renderable crisis response for the
   * caller to send on its own surface, or `{ kind: 'safe' }`.
   */
  async screen(userId: string, content: string): Promise<ScreeningVerdict> {
    if (this.tripwire(content)) {
      const response = await this.escalation.escalate(userId, 'tripwire', {
        startAftermath: false,
      });
      return { kind: 'crisis', response };
    }

    const classification = await this.classifier.classify(content);
    if (classification === 'crisis') {
      const response = await this.escalation.escalate(userId, 'classifier', {
        startAftermath: false,
      });
      return { kind: 'crisis', response };
    }

    return { kind: 'safe' };
  }
}
