import { Injectable } from '@nestjs/common';
import { Client } from 'discord.js';
import { prisma } from '@wabi/shared';
import { SessionBufferService } from '../session-buffer/session-buffer.service';
import { CoachingSessionService } from '../session-buffer/coaching-session.service';
import { SchedulerService } from '../scheduler/scheduler.service';
import { ContactPolicyService } from '../contact-policy/contact-policy.service';

const FOLLOW_UP_DELAY_MINUTES = 30;
// The Aftermath Window matches the Redis quarantine key's TTL (ADR-0010). Used as the lookback when
// the durable EscalationEvent backstops a degraded Redis read.
const AFTERMATH_WINDOW_HOURS = 24;
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
    try {
      await this.sessionBuffer.clearAndQuarantine(userId);
    } catch {
      // Redis down at escalation time — the durable do-not-mine flag (above) and the EscalationEvent
      // still protect the person, and isQuarantined falls back to the event, so this must not throw
      // out of the escalation path (ADR-0021).
    }

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
      // Redis is unreadable — or the window key was never written because Redis was down at
      // escalation time. Fail CLOSED (ADR-0021): consult the durable EscalationEvent and assume the
      // person is still in aftermath if there was a recent escalation, rather than the old fail-OPEN
      // `return false` that dropped the softened tone on any Redis blip.
      return this.recentEscalation(userId);
    }
  }

  private async recentEscalation(userId: string): Promise<boolean> {
    try {
      const since = new Date(Date.now() - AFTERMATH_WINDOW_HOURS * 60 * 60 * 1000);
      const event = await prisma.escalationEvent.findFirst({
        where: { userId, timestamp: { gte: since } },
      });
      return event != null;
    } catch {
      // Postgres is also down — there is nothing more authoritative to consult.
      return false;
    }
  }
}
