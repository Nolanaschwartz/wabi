import { Module } from '@nestjs/common';
import { JournalService } from './journal.service';
import { JournalController } from './journal.controller';
import { CoachingModule } from '../coaching/coaching.module';
import { XpModule } from '../xp/xp.module';

@Module({
  imports: [CoachingModule, XpModule],
  providers: [JournalService],
  controllers: [JournalController],
  exports: [JournalService],
})
export class JournalModule {}
