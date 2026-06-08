import { Module } from '@nestjs/common';
import { CrisisScreeningService } from './crisis-screening.service';
import { CrisisResourcesService } from './crisis-resources.service';
import { EscalationService } from './escalation.service';
import { CrisisAftermathModule } from '../crisis-aftermath/crisis-aftermath.module';

@Module({
  imports: [CrisisAftermathModule],
  providers: [CrisisScreeningService, CrisisResourcesService, EscalationService],
  exports: [CrisisScreeningService, CrisisResourcesService, EscalationService],
})
export class CrisisModule {}
