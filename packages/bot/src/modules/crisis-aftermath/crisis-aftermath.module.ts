import { Module, OnModuleInit } from '@nestjs/common';
import { CrisisAftermathService } from './crisis-aftermath.service';
import { SessionBufferModule } from '../session-buffer/session-buffer.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { ContactPolicyModule } from '../contact-policy/contact-policy.module';

@Module({
  imports: [SessionBufferModule, SchedulerModule, ContactPolicyModule],
  providers: [CrisisAftermathService],
  exports: [CrisisAftermathService],
})
export class CrisisAftermathModule implements OnModuleInit {
  constructor(private readonly service: CrisisAftermathService) {}

  // Registers the follow-up worker on the shared Scheduler; the client lifecycle is the Scheduler's.
  async onModuleInit(): Promise<void> {
    await this.service.init();
  }
}
