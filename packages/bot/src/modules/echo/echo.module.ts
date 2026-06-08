import { Module } from '@nestjs/common';
import { EchoController } from './echo.controller';
import { CrisisModule } from '../crisis/crisis.module';
import { CoachingModule } from '../coaching/coaching.module';

@Module({
  providers: [EchoController],
  // CrisisModule supplies the tripwire screen and the EscalationService; the escalation act
  // (resources + Event + aftermath) now lives behind that one seam, not in this controller.
  imports: [CrisisModule, CoachingModule],
})
export class EchoModule {}
