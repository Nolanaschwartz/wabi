import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { ClassifierService } from '../crisis/classifier.service';
import { CoachService } from '../coaching/coach.service';
import { XpService } from '../xp/xp.service';

// A saved journal entry is worth this much XP. The award belongs to "writing an entry",
// so it lives here next to the persist — not at the call site, where a second caller would
// have to re-encode it (and a crisis entry could accidentally still be rewarded).
const JOURNAL_XP_AWARD = 10;

const PROMPTS = [
  "What's one thing that went well today?",
  "What's weighing on your mind right now?",
  "Describe a moment when you felt proud of yourself.",
  "What's something you're looking forward to?",
  "What's a small win you had this week?",
  "What would you tell your younger self about gaming?",
  "What's one boundary you want to set this week?",
  "When did you last feel truly relaxed?",
  "What's a habit you want to build or break?",
  "What made you smile today?",
];

@Injectable()
export class JournalService {
  constructor(
    private readonly classifier: ClassifierService,
    private readonly coach: CoachService,
    private readonly xp: XpService,
  ) {}

  async prompt(): Promise<string> {
    const idx = Math.floor(Math.random() * PROMPTS.length);
    return PROMPTS[idx];
  }

  async write(
    discordId: string,
    content: string,
  ): Promise<{ crisis: boolean; reflection: string; xpAwarded: number }> {
    const classification = await this.classifier.classify(content);

    if (classification === 'crisis') {
      // No persist, no reward — a crisis entry is handed off to safety, not gamified.
      return { crisis: true, reflection: '', xpAwarded: 0 };
    }

    const reflection = await this.generateReflection(content);

    await prisma.journalEntry.create({
      data: {
        userId: discordId,
        content,
        reflection: reflection || null,
      },
    });

    await this.xp.award(discordId, JOURNAL_XP_AWARD, 'journal');

    return { crisis: false, reflection: reflection || '', xpAwarded: JOURNAL_XP_AWARD };
  }

  private async generateReflection(content: string): Promise<string> {
    try {
      // Journal reflection is a distinct task from DM coaching, so it supplies its own system
      // persona (the coach model adapter no longer bakes one in — see coach-prompt.ts).
      const reply = await this.coach.generate(
        'You are Wabi. Reflect briefly and supportively on this journal entry. Be warm, brief (under 150 chars), and specific to what they wrote. Never give clinical advice or diagnose.',
        content,
      );
      return reply;
    } catch {
      return "Thanks for journaling. Reflecting on your thoughts is a healthy habit.";
    }
  }
}
