import { Injectable } from '@nestjs/common';
import type { APIEmbed } from 'discord.js';
import { prisma } from '@wabi/shared';
import { CrisisResourcesService } from './crisis-resources.service';
import { CrisisAftermathService } from '../crisis-aftermath/crisis-aftermath.service';
import { AccountReads } from '../user/account-reads.service';

export type EscalationLayer = 'tripwire' | 'classifier';

/**
 * The surface a crisis fired on — the ONE thing that varies the escalation's downstream policy
 * (ADR-0010/0016/0028):
 *  - `conversation` — a live DM turn. Opens the post-crisis DM-session aftermath window.
 *  - `field`        — a logged inner-state field (Journal/Mood/Tilt note). Escalates resources + a
 *                     content-free Event, but is NOT a Conversation, so it never opens the aftermath.
 *
 * Callers name their surface; the surface→aftermath mapping lives in one place (escalate), so the two
 * detection paths (DM hot path vs the shared screened-record path) can never drift on aftermath policy.
 */
export type CrisisSurface = 'conversation' | 'field';

/**
 * A surface-agnostic crisis response: a renderable payload the caller sends on its own channel
 * (`message.reply` for a DM, `interaction.editReply` for a slash command). Decoupling the response
 * from `discord.js`'s `Message` is what lets every surface escalate through one seam (ADR-0028).
 */
export interface CrisisResponse {
  embeds: APIEmbed[];
}

@Injectable()
export class EscalationService {
  constructor(
    private readonly accountReads: AccountReads,
    private readonly crisisResources: CrisisResourcesService,
    private readonly crisisAftermath: CrisisAftermathService,
  ) {}

  /**
   * The single entry for a Crisis Escalation, from either detection layer (ADR-0006) and any surface
   * (DM, `/journal`, `/mood` note, `/tilt` trigger — ADR-0028). It returns the locale resources as a
   * renderable payload rather than replying itself (no transport coupling), records exactly ONE
   * content-free Escalation Event tagged with the layer, then hands off to the Crisis Aftermath ONLY
   * for a `conversation` surface. The aftermath policy is keyed off {@link CrisisSurface} here, so no
   * caller decides it for itself (ADR-0010/0016/0028).
   */
  async escalate(
    userId: string,
    layer: EscalationLayer,
    surface: CrisisSurface,
  ): Promise<CrisisResponse> {
    const response = await this.buildResponse(userId);
    await this.logEvent(userId, layer);
    // Surface policy lives here, nowhere else: only a live DM Conversation opens the aftermath window.
    if (surface === 'conversation') await this.crisisAftermath.onEscalation(userId);
    return response;
  }

  private async buildResponse(userId: string): Promise<CrisisResponse> {
    const locale = await this.accountReads.localeFor(userId);
    const resources = this.crisisResources.resourcesFor(locale);

    const resourceLines = resources.resources.map((r) => {
      if (r.type === 'web') return `• ${r.name}: ${r.url}`;
      if (r.type === 'info') return `• ${r.name}`;
      return `• ${r.name}: ${r.phone}`;
    });

    const embed: APIEmbed = {
      color: 0x000000,
      title: '🚨 You matter',
      description:
        "If you're in crisis, real people are here to help. Please reach out:",
      fields: [
        {
          name: 'Resources',
          value: resourceLines.join('\n'),
          inline: false,
        },
      ],
      footer: { text: 'These numbers are free and confidential' },
    };

    return { embeds: [embed] };
  }

  private async logEvent(userId: string, layer: EscalationLayer): Promise<void> {
    try {
      await prisma.escalationEvent.create({
        data: { userId, layer },
      });
    } catch {
      // Best-effort, content-free logging (ADR-0010).
    }
  }
}
