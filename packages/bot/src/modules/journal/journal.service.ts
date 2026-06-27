import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { ScreenedText } from '../crisis/screened';
import { CoachService } from '../coaching/coach.service';
import { HabitEngagementService } from '../habit-engagement/habit-engagement.service';
import { AccessResolver } from '../billing/access-resolver';

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

export interface JournalEntrySummary {
  content: string;
  reflection: string | null;
  createdAt: Date;
}

@Injectable()
export class JournalService {
  constructor(
    private readonly coach: CoachService,
    private readonly habitEngagement: HabitEngagementService,
    private readonly accessResolver: AccessResolver,
  ) {}

  async prompt(): Promise<string> {
    const idx = Math.floor(Math.random() * PROMPTS.length);
    return PROMPTS[idx];
  }

  // Plain persist: reflect → save the entry → log the Engagement (XP + streak) through the single
  // writer (ADR-0027). The entry is taken as a `ScreenedText` proof, not a bare string, so the entry
  // content structurally cannot reach this writer unscreened (ADR-0028/0031); `entry.freeText` is the
  // exact crisis-safe text the upstream screen cleared. Derivation + consent stay in the recorder.
  async write(discordId: string, entry: ScreenedText): Promise<JournalWriteResult> {
    const content = entry.freeText;
    const reflection = await this.generateReflection(content);

    await prisma.journalEntry.create({
      data: {
        userId: discordId,
        content,
        reflection: reflection || null,
      },
    });

    // XP is awarded once per engaged day, so a second entry the same day still saves but does not
    // re-award. Thread the person's timezone (same source the coaching path uses) so the journal
    // Engagement buckets its day boundary in the person's tz, agreeing with coaching and /profile.
    const { timezone } = await this.accessResolver.resolveAccount(discordId);
    const { xpAwarded } = await this.habitEngagement.record(discordId, 'journal', timezone);

    return { reflection: reflection || '', xpAwarded };
  }

  // Read-back for the get_entry tool: the person's most recent entry, or null if they have none. A pure
  // read — no write, no engagement. Allowed at any access tier (ADR-0011), so the gate lives upstream.
  async latestEntry(discordId: string): Promise<JournalEntrySummary | null> {
    return prisma.journalEntry.findFirst({
      where: { userId: discordId },
      orderBy: { createdAt: 'desc' },
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
