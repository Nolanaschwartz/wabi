import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { CoachService } from '../coaching/coach.service';
import { HabitEngagementService } from '../habit-engagement/habit-engagement.service';

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

export interface JournalWriteResult {
  reflection: string;
  xpAwarded: number;
}

@Injectable()
export class JournalService {
  constructor(
    private readonly coach: CoachService,
    private readonly habitEngagement: HabitEngagementService,
  ) {}

  async prompt(): Promise<string> {
    const idx = Math.floor(Math.random() * PROMPTS.length);
    return PROMPTS[idx];
  }

  // Plain persist: reflect → save the entry → log the Engagement (XP + streak) through the single
  // writer (ADR-0027). Crisis screening of the entry content and consent-gated derivation are owned by
  // InnerStateLogger (ADR-0028/0029), so this only ever runs from inside that logger's safe-path
  // closure — crisis text never reaches it.
  async write(discordId: string, content: string): Promise<JournalWriteResult> {
    const reflection = await this.generateReflection(content);

    await prisma.journalEntry.create({
      data: {
        userId: discordId,
        content,
        reflection: reflection || null,
      },
    });

    // XP is awarded once per engaged day, so a second entry the same day still saves but does not
    // re-award.
    const { xpAwarded } = await this.habitEngagement.record(discordId, 'journal');

    return { reflection: reflection || '', xpAwarded };
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
