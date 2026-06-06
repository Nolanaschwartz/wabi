import { Module, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { CrisisAftermathService } from './crisis-aftermath.service';
import { SessionBufferModule } from '../session-buffer/session-buffer.module';
import { SessionBufferService } from '../session-buffer/session-buffer.service';

@Module({
  imports: [SessionBufferModule],
  providers: [CrisisAftermathService],
  exports: [CrisisAftermathService],
})
export class CrisisAftermathModule implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly service: CrisisAftermathService) {}

  async onModuleInit(): Promise<void> {
    await this.service.init();
  }

  async onModuleDestroy(): Promise<void> {
    await this.service.destroy();
  }
}
