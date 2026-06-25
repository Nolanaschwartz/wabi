import { Injectable } from '@nestjs/common';
import { Client } from 'discord.js';
import { setupLinkMessage } from '../../lib/setup-link';
import { AccountReads } from '../user/account-reads.service';

// One-time greeting that INVITES the first conversation. It must not enroll the user into
// the recurring opt-in check-in cadence (ADR-0008) — the actual coaching happens when the
// user replies, via the existing messageCreate pipeline.
const WELCOME_OPENER =
  "👋 Welcome to Wabi! Let's start with a quick check-in — how are you feeling about your game right now?";

@Injectable()
export class WelcomeService {
  constructor(
    private readonly client: Client,
    private readonly accountReads: AccountReads,
  ) {}

  /**
   * Decide which DM a freshly-joined member should receive and deliver it.
   * Consented User → welcome opener (their reply flows into normal DM coaching).
   * Unknown / unconsented → the shared "finish setup" link (never coaches, never creates a User).
   * Closed-DM and other delivery failures are swallowed; this never throws.
   */
  async welcome(discordId: string): Promise<void> {
    const { consented } = await this.accountReads.consentState(discordId);

    const content = consented
      ? WELCOME_OPENER
      : setupLinkMessage(process.env.NEXT_PUBLIC_BASE_URL || 'https://wabi.gg');

    try {
      await this.client.users.send(discordId, { content });
    } catch {
      // User may have closed DMs — membership and account are unaffected.
    }
  }
}
