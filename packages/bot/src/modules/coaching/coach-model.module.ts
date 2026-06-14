import { Module } from '@nestjs/common';
import { CoachService } from './coach.service';

/**
 * The coach model adapter on its own, so any module that just needs to call the LLM (e.g. JournalModule
 * for entry reflections) can depend on this instead of all of CoachingModule. That severs the
 * CoachingModule ↔ JournalModule cycle the DM router would otherwise create (the router dispatches to
 * JournalDmHandler, while JournalService only needs the model). CoachService injects nothing — it
 * resolves its provider lazily from env — so this module has no imports.
 */
@Module({
  providers: [CoachService],
  exports: [CoachService],
})
export class CoachModelModule {}
