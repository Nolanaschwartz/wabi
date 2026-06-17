import { Injectable, OnModuleInit } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { SEED_TOPICS } from '../seed-topics';

const SINGLETON_ID = 'singleton';

/**
 * Owns the ResearchConfig singleton + ResearchTopic list (ADR-0034). Reuses the shared `prisma`
 * singleton (the codebase pattern); never constructs its own client. DB is the source of truth
 * after first boot — `loadBounds()`/`SEED_TOPICS`/`RESEARCH_MAX_*` demote to bootstrap seeds only.
 *
 * Isolation: this service touches ONLY ResearchConfig/ResearchTopic — never User or StrategyDraft.
 */
@Injectable()
export class ResearchConfigService implements OnModuleInit {
  async onModuleInit(): Promise<void> {
    // Fail safe: if Postgres is down the worker still boots (research is non-critical, ADR-0034);
    // admin reads will surface the error per-request instead of blocking startup.
    await this.seedOnBoot().catch(() => undefined);
  }

  /**
   * Idempotent boot seed. Upserts the config singleton with create-only defaults (the empty
   * `update` guarantees a repeat boot never clobbers operator edits), and seeds topics from
   * SEED_TOPICS only when the table is empty. Re-running must not duplicate or reset anything.
   */
  async seedOnBoot(): Promise<void> {
    await prisma.researchConfig.upsert({
      where: { id: SINGLETON_ID },
      update: {},
      create: { id: SINGLETON_ID },
    });

    const topicCount = await prisma.researchTopic.count();
    if (topicCount === 0) {
      await prisma.researchTopic.createMany({
        data: SEED_TOPICS.map((text) => ({ text })),
        skipDuplicates: true,
      });
    }
  }

  /** One fetch for the whole admin screen: the config singleton plus the topic list. */
  async getConfig(): Promise<{ config: unknown; topics: unknown[] }> {
    const [config, topics] = await Promise.all([
      prisma.researchConfig.findUnique({ where: { id: SINGLETON_ID } }),
      prisma.researchTopic.findMany({ orderBy: { createdAt: 'asc' } }),
    ]);
    return { config, topics };
  }
}
