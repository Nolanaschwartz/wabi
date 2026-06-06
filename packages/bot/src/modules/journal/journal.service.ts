import { Injectable } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { ClassifierService } from '../coaching/classifier.service';
import { CoachService } from '../coaching/coach.service';

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
  ) {}

  async prompt(): Promise<string> {
    const idx = Math.floor(Math.random() * PROMPTS.length);
    return PROMPTS[idx];
  }

  async write(
    discordId: string,
    content: string,
  ): Promise<{ crisis: boolean; reflection: string }> {
    const classification = await this.classifier.classify(content);

    if (classification === 'crisis') {
      return { crisis: true, reflection: '' };
    }

    const reflection = await this.generateReflection(content);

    await prisma.journalEntry.create({
      data: {
        userId: discordId,
        content,
        reflection: reflection || null,
      },
    });

    return { crisis: false, reflection: reflection || '' };
  }

  private async generateReflection(content: string): Promise<string> {
    try {
      const reply = await this.coach.generate(
        `Reflect briefly and supportively on this journal entry. Be warm, brief (under 150 chars), and specific to what they wrote:\n${content}`,
      );
      return reply;
    } catch {
      return "Thanks for journaling. Reflecting on your thoughts is a healthy habit.";
    }
  }
}
