import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import {
  CrisisScreeningService,
  ScreenedRecord,
} from '../crisis/crisis-screening.service';
import { CoachService } from '../coaching/coach.service';
import { HabitEngagementService } from '../habit-engagement/habit-engagement.service';
import { InnerStateMemoryService } from '../memory/inner-state-memory.service';

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

export type JournalWriteResult = ScreenedRecord<{
  reflection: string;
  xpAwarded: number;
}>;

@Injectable()
export class JournalService {
  constructor(
    private readonly screening: CrisisScreeningService,
    private readonly coach: CoachService,
    private readonly habitEngagement: HabitEngagementService,
    private readonly innerStateMemory: InnerStateMemoryService,
  ) {}

  async prompt(): Promise<string> {
    const idx = Math.floor(Math.random() * PROMPTS.length);
    return PROMPTS[idx];
  }

  async write(discordId: string, content: string): Promise<JournalWriteResult> {
    // The entry content crosses the shared screened-record path before persisting (ADR-0028). A
    // crisis hit surfaces the real locale Crisis Resources + records one Escalation Event — but no
    // DM-session aftermath, since a journal entry is not a Conversation — and the entry is not saved.
    return this.screening.guard(discordId, content, async () => {
      const reflection = await this.generateReflection(content);

      await prisma.journalEntry.create({
        data: {
          userId: discordId,
          content,
          reflection: reflection || null,
        },
      });

      // Log the Engagement (XP + streak) through the single writer (ADR-0027). XP is awarded once per
      // engaged day, so a second entry the same day still saves but does not re-award.
      const { xpAwarded } = await this.habitEngagement.record(discordId, 'journal');

      // Feed the screened free text into derived Memory, consent-gated and off by default (ADR-0029).
      // This runs inside guard()'s success closure, so crisis text never reaches it. No metric is
      // included — only the narrative, prefixed with its source word for extractor context.
      await this.innerStateMemory.deriveIfConsented(discordId, `Journal: ${content}`);

      return { reflection: reflection || '', xpAwarded };
    });
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
