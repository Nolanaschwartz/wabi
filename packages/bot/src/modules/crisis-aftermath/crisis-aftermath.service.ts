import { Injectable } from '@nestjs/common';
import { Client } from 'discord.js';
import { prisma } from '@wabi/shared';
import { SessionBufferService } from '../session-buffer/session-buffer.service';
import { CoachingSessionService } from '../session-buffer/coaching-session.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { ContactPolicyService } from '../contact-policy/contact-policy.service';

const FOLLOW_UP_DELAY_MINUTES = 30;
const FOLLOW_UP_MESSAGES = [
  "Hey, I'm still here. How are you doing now?",
  "Just checking in - want to talk about anything?",
  "I've been thinking about our conversation. How are you feeling?",
];

@Injectable()
export class CrisisAftermathService {
  constructor(
    private readonly sessionBuffer: SessionBufferService,
    private readonly coachingSession: CoachingSessionService,
    private readonly scheduler: SchedulerService,
    private readonly client: Client,
    private readonly contactPolicy: ContactPolicyService,
  ) {}

  async init(): Promise<void> {
    // Register the follow-up worker on the shared Scheduler; lifecycle is the Scheduler's.
    await this.scheduler.work('crisis-follow-up', this.followUpJob.bind(this));
  }

  async onEscalation(userId: string): Promise<void> {
    // Single source of truth for "never mine this session": the Postgres do-not-mine flag the
    // sweeper reads. Set on BOTH crisis paths (classifier + tripwire), since onEscalation is the
    // one call both make. The Redis buffer clear + quarantine key are the time-bounded aftermath
    // window, a separate concern. (Issue #24 / ADR-0010/0016.)
    await this.coachingSession.quarantine(userId);
    await this.sessionBuffer.clearAndQuarantine(userId);

    if (!this.scheduler.available) return;

    const followUpMessage = FOLLOW_UP_MESSAGES[
      Math.floor(Math.random() * FOLLOW_UP_MESSAGES.length)
    ];

    // One-off delayed job (not a recurring cron). The follow-up respects quiet hours via the Contact
    // Policy: if the 30-minute mark lands in quiet hours it defers to the next allowed window rather
    // than waking the person (ADR-0008/0010), but is exempt from opt-in and the sparing rate.
    const startAfterSeconds = await this.followUpDelaySeconds(userId);
    await this.scheduler.sendAfter(
      'crisis-follow-up',
      { userId, message: followUpMessage },
      startAfterSeconds,
    );
  }

  private async followUpDelaySeconds(userId: string): Promise<number> {
    const baseFireAt = new Date(Date.now() + FOLLOW_UP_DELAY_MINUTES * 60 * 1000);
    const user = await prisma.user
      .findUnique({ where: { discordId: userId }, select: { timezone: true } })
      .catch(() => null);
    const decision = this.contactPolicy.mayContact(
      user?.timezone ?? 'UTC',
      'crisis-follow-up',
      baseFireAt,
    );
    if (decision.allow) {
      return FOLLOW_UP_DELAY_MINUTES * 60;
    }
    const deferMs = (decision.deferUntil?.getTime() ?? baseFireAt.getTime()) - Date.now();
    return Math.max(0, Math.round(deferMs / 1000));
  }

  private async followUpJob(job: unknown[]): Promise<void> {
    const data = job[0] as { userId: string; message: string };
    if (!data?.userId) return;

    // Deliver the gentle follow-up DM, then record the content-free event (ADR-0010).
    try {
      await this.client.users.send(data.userId, { content: data.message });
    } catch {
      // The person may have closed DMs — the escalation already surfaced resources.
    }

    try {
      await prisma.escalationEvent.create({
        data: { userId: data.userId, layer: 'follow-up' },
      });
    } catch {
      // Non-critical, content-free logging.
    }
  }

  async isQuarantined(userId: string): Promise<boolean> {
    try {
      // Policy: a fresh, live session cancels the aftermath window. The raw "is the window still
      // set?" fact is owned by SessionBuffer (its key, its TTL) — we read it through the interface,
      // never the underlying client.
      const raw = await this.sessionBuffer.getContext(userId);
      if (raw) return false;

      return await this.sessionBuffer.inAftermathWindow(userId);
    } catch {
      return false;
    }
  }
}
