import { Injectable } from '@nestjs/common';
import { UserService } from './user.service';

/**
 * Account read intents (docs/contexts/accounts/CONTEXT.md). Each method is a named read keyed to what
 * one caller needs — it owns its own Prisma projection and its own safe default, so callers stop
 * threading `select`s and whole-row reads of their own. Distinct from the full-row read `decideAccess`
 * requires (which needs the entire subscription shape). Reads never throw: a failed read resolves to
 * the safe default, matching the behaviour of the call sites this replaced (ADR-0011/0021).
 */
@Injectable()
export class AccountReads {
  constructor(private readonly users: UserService) {}

  /**
   * Whether the person has consented (+ their timezone, UTC-defaulted in one place). The welcome opener
   * gates on `consented`: an unknown user, or one who has not accepted consent, is `{ consented: false }`,
   * so the opener surfaces the setup link instead (ADR-0011/0015). Coaching reads consent (and the access
   * decision, and the coach-prompt timezone) from a single `AccessResolver.resolveAccount` instead — so
   * this is the welcome path's read.
   */
  async consentState(
    discordId: string,
  ): Promise<{ consented: boolean; timezone: string }> {
    const user = await this.users
      .findByDiscordId(discordId, { consentAcceptedAt: true, timezone: true })
      .catch(() => null);
    return { consented: !!user?.consentAcceptedAt, timezone: user?.timezone ?? 'UTC' };
  }

  /**
   * The Discord locale used to key Crisis Resources on escalation; owns the en-US default for an
   * unknown user or a DM with no exposed locale (ADR-0006/0023).
   */
  async localeFor(discordId: string): Promise<string> {
    const user = await this.users
      .findByDiscordId(discordId, { locale: true })
      .catch(() => null);
    return user?.locale ?? 'en-US';
  }
}
