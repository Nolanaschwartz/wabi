import { Module } from '@nestjs/common';
import { CrisisScreeningService } from './crisis-screening.service';
import { CrisisResourcesService } from './crisis-resources.service';

@Module({
  providers: [CrisisScreeningService, CrisisResourcesService],
  exports: [CrisisScreeningService, CrisisResourcesService],
})
export class CrisisModule {}
