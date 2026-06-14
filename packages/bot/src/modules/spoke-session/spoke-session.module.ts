import { Module } from '@nestjs/common';
import { SpokeSessionService } from './spoke-session.service';

/**
 * Provides the spoke-keyed conversational floor (hub-and-spoke continuity). Both the hub router
 * (CoachingModule) and spokes that arm the floor (e.g. JournalDmHandler in JournalModule) import this,
 * sharing one Redis client. Connected at module init, mirroring SessionBufferService — the bot must
 * come online even if Redis is down (degraded), so init swallows connect failures.
 */
@Module({
  providers: [
    {
      provide: SpokeSessionService,
      useFactory: async () => {
        const svc = new SpokeSessionService();
        await svc.init();
        return svc;
      },
    },
  ],
  exports: [SpokeSessionService],
})
export class SpokeSessionModule {}
