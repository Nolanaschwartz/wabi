import { prisma } from '@wabi/shared';
import { ClassifierService } from '../coaching/classifier.service';

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

export class JournalService {
  constructor(private readonly classifier: ClassifierService) {}

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

    const reflection = this.generateReflection(content);

    await prisma.journalEntry.create({
      data: {
        userId: discordId,
        content,
        reflection: reflection ?? null,
      },
    });

    return { crisis: false, reflection: reflection ?? '' };
  }

  private generateReflection(content: string): string {
    if (content.toLowerCase().includes('hard') || content.toLowerCase().includes('difficult')) {
      return "It takes courage to write about the hard stuff. You're doing better than you think.";
    }

    if (content.toLowerCase().includes('good') || content.toLowerCase().includes('great') || content.toLowerCase().includes('happy')) {
      return "It's great to hear you're feeling positive. Hold onto that feeling.";
    }

    if (content.length < 20) {
      return "Thanks for sharing. Even a small note is a step forward.";
    }

    return "Thanks for journaling. Reflecting on your thoughts is a healthy habit.";
  }
}
