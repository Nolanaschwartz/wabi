import { Module } from '@nestjs/common';
import { CrisisScreeningService } from './crisis-screening.service';
import { CrisisResourcesService } from './crisis-resources.service';
import { EscalationService } from './escalation.service';
import { ClassifierService } from './classifier.service';
import { CrisisAftermathModule } from '../crisis-aftermath/crisis-aftermath.module';

// The Crisis Classifier is the contextual LLM detection layer (ADR-0006) — it lives here beside the
// tripwire, not in coaching, so screening composes both layers without a coaching↔crisis cycle, and
// any free-text surface (coaching, journal) depends on this module for detection (ADR-0028).
@Module({
  imports: [CrisisAftermathModule],
  providers: [
    CrisisScreeningService,
    CrisisResourcesService,
    EscalationService,
    ClassifierService,
  ],
  exports: [
    CrisisScreeningService,
    CrisisResourcesService,
    EscalationService,
    ClassifierService,
  ],
})
export class CrisisModule {}
