import { Module, OnModuleInit } from '@nestjs/common';
import { SessionBufferService } from './session-buffer.service';
import { CoachingSessionService } from './coaching-session.service';
import { SessionSweeper } from './session-sweeper.service';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [MemoryModule],
  providers: [
    {
      provide: SessionBufferService,
      useFactory: async () => {
        const svc = new SessionBufferService();
        await svc.init();
        return svc;
      },
    },
    CoachingSessionService,
    SessionSweeper,
  ],
  exports: [SessionBufferService, CoachingSessionService],
})
export class SessionBufferModule implements OnModuleInit {
  async onModuleInit(): Promise<void> {}
}
