import { Module } from '@nestjs/common';
import { JournalService } from './journal.service';
import { JournalController } from './journal.controller';
import { CoachingModule } from '../coaching/coaching.module';
import { CrisisModule } from '../crisis/crisis.module';
import { XpModule } from '../xp/xp.module';

@Module({
  imports: [CoachingModule, CrisisModule, XpModule],
  providers: [JournalService, JournalController],
  exports: [JournalService],
})
export class JournalModule {}
