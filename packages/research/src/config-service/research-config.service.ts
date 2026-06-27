import { BadRequestException, ConflictException, Injectable, OnModuleInit } from '@nestjs/common';
import { prisma } from '@wabi/shared';
import { SEED_TOPICS } from '../seed-topics';
import { Bounds } from '../types';
import { RANGES, fromConfigRow, type ResearchBounds } from '../run-bounds';

// The Run Bounds (shape, defaults, ranges, row→Bounds mapping) have ONE owner: run-bounds.ts.
// Re-exported here so the admin controller's existing import keeps resolving.
export type { ResearchBounds } from '../run-bounds';

/** True for the Prisma unique-constraint violation we translate into a 409. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

const SINGLETON_ID = 'singleton';

/**
 * Owns the ResearchConfig singleton + ResearchTopic list (ADR-0034). Reuses the shared `prisma`
 * singleton (the codebase pattern); never constructs its own client. DB is the source of truth
 * after first boot — `SEED_TOPICS`/`RESEARCH_MAX_*` demote to bootstrap seeds only. This service is
 * the sole reader of `ResearchConfig`; `loadRunBounds()` is the run's typed view of the singleton.
 *
 * Isolation: this service touches ONLY ResearchConfig/ResearchTopic — never User or StrategyDraft.
 */
@Injectable()
export class ResearchConfigService implements OnModuleInit {
  async onModuleInit(): Promise<void> {
    // Fail safe: if Postgres is down the worker still boots (research is non-critical, ADR-0034);
    // admin reads will surface the error per-request instead of blocking startup. Log it like the
    // bot logs degradation, so a failed seed isn't an invisible empty admin screen.
    await this.seedOnBoot().catch((err) =>
      console.error('[research] boot seed failed; continuing degraded', err),
    );
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

  /**
   * The runner's read: only enabled topics, oldest first. Disabled topics stay in the table
   * (operator can re-enable) but never enter a run. Established now; the run itself lands later.
   */
  async getEnabledTopics(): Promise<unknown[]> {
    return prisma.researchTopic.findMany({
      where: { enabled: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * The run's bounds, read from the `ResearchConfig` singleton (the source of truth after boot) and
   * mapped into the full {@link Bounds} the core expects. This service is the **sole reader** of
   * `ResearchConfig` (ADR-0034) — the runner calls this instead of touching Prisma directly.
   *
   * Always returns a fully-populated `Bounds` and **never throws**: a degraded read logs and falls
   * back to the schema-mirroring defaults, so a run still proceeds with sane bounds (research is
   * non-critical). Env (`RESEARCH_SEARCH_LIMIT`) is resolved lazily per call — never frozen at import.
   */
  async loadRunBounds(): Promise<Bounds> {
    let row: Partial<Record<keyof Bounds, unknown>> | null = null;
    try {
      row = (await prisma.researchConfig.findUnique({
        where: { id: SINGLETON_ID },
      })) as Partial<Record<keyof Bounds, unknown>> | null;
    } catch (err) {
      console.error('[research] reading run bounds failed; using defaults', err);
    }
    return fromConfigRow(row, process.env);
  }

  /**
   * Adds a topic. The model's `text @unique` is the integrity boundary; we catch the resulting
   * P2002 and translate to a ConflictException so the admin surface returns 409 (mirrors the bot's
   * strategy-admin dedupe) instead of leaking a raw Prisma error.
   */
  async createTopic(text: string): Promise<unknown> {
    try {
      return await prisma.researchTopic.create({ data: { text } });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({ status: 'duplicate', message: 'Topic already exists' });
      }
      throw err;
    }
  }

  /** Updates a topic's text and/or enabled state. A text change can collide → 409 (as create). */
  async updateTopic(id: string, data: { text?: string; enabled?: boolean }): Promise<unknown> {
    const update: { text?: string; enabled?: boolean } = {};
    if (data.text !== undefined) update.text = data.text;
    if (data.enabled !== undefined) update.enabled = data.enabled;
    try {
      return await prisma.researchTopic.update({ where: { id }, data: update });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictException({ status: 'duplicate', message: 'Topic already exists' });
      }
      throw err;
    }
  }

  /**
   * Tunes the run bounds on the singleton. Server-side range validation is the gate: every
   * field must be a finite number inside its RANGES band. Integer-typed bounds (where min is
   * itself an integer) additionally require a whole number, so an operator can never silently
   * save a zero budget (or a degenerate timeout/count) that produces nothing (issue 03, ADR-0034).
   * Float-typed bounds (e.g. budgetPressureFraction, where min is fractional) accept any finite
   * number in [min, max]. Validates ALL fields and reports every offender; rejects with
   * BadRequestException before any write.
   */
  async updateBounds(bounds: ResearchBounds): Promise<unknown> {
    const offenders: string[] = [];
    const data: Partial<ResearchBounds> = {};

    for (const key of Object.keys(RANGES) as (keyof ResearchBounds)[]) {
      const { min, max } = RANGES[key];
      const value = bounds[key];
      const isIntegerBound = Number.isInteger(min);
      const valid =
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= min &&
        value <= max &&
        (!isIntegerBound || Number.isInteger(value));
      if (!valid) {
        const kind = isIntegerBound ? 'integer' : 'number';
        offenders.push(`${key} must be a ${kind} in [${min}, ${max}] (got ${String(value)})`);
      } else {
        data[key] = value;
      }
    }

    if (offenders.length > 0) {
      throw new BadRequestException({ status: 'invalid-bounds', message: offenders.join('; ') });
    }

    return prisma.researchConfig.update({ where: { id: SINGLETON_ID }, data });
  }

  /**
   * Persists the schedule (cron + enabled) to the singleton (issue 04, ADR-0034). The cron's
   * well-formedness is validated by ResearchScheduleService/cron-compile BEFORE this is reached —
   * this method is pure persistence. A null cron means "unscheduled".
   */
  async updateSchedule(cron: string | null, enabled: boolean): Promise<unknown> {
    return prisma.researchConfig.update({
      where: { id: SINGLETON_ID },
      data: { scheduleCron: cron, scheduleEnabled: enabled },
    });
  }

  /** Removes a topic outright. */
  async deleteTopic(id: string): Promise<unknown> {
    return prisma.researchTopic.delete({ where: { id } });
  }
}
