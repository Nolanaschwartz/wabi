import { Injectable } from '@nestjs/common';
import { TiltService } from '../tilt/tilt.service';
import type { ClassifierContext } from '../crisis/classifier.service';
import type { SessionContext } from '../session-buffer/session-buffer.service';

/**
 * The one named home for assembling the safety classifier's disambiguation context. It gathers the
 * tilt signal (`hasActiveSession`) and the recent session-buffer turns into the `ClassifierContext`
 * the classifier defines — the classifier keeps ownership of that shape, the prompt envelope, and the
 * user-message clamp; this assembler only gathers.
 *
 * Always returns an object so EVERY screening call carries context (empty when the turn is cold) — the
 * classifier wraps it in a uniform envelope either way. Every fetch is best-effort: a failed tilt
 * lookup must never block the classifier from running, so it degrades to `inTiltSession: false` rather
 * than throwing, and missing turns simply yield no `recentTurns`. The zero-dependency tripwire floor
 * still runs upstream regardless. (ADR-0021.)
 *
 * The live session is fetched once upstream on the DM path and passed in, so the assembler reuses it
 * rather than re-reading Redis. It lives in the coaching module next to its collaborators; the crisis
 * module gains no dependency on Wellbeing data sources.
 */
@Injectable()
export class ClassifierContextAssembler {
  constructor(private readonly tilt: TiltService) {}

  async assemble(userId: string, session: SessionContext | null): Promise<ClassifierContext> {
    let inTiltSession = false;
    try {
      inTiltSession = await this.tilt.hasActiveSession(userId);
    } catch {
      inTiltSession = false;
    }

    const recentTurns = session?.turns?.length ? session.turns : undefined;

    return { inTiltSession, recentTurns };
  }
}
