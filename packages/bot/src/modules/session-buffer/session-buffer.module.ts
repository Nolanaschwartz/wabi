import { Module, OnModuleInit } from '@nestjs/common';
import { SessionBufferService } from './session-buffer.service';

@Module({
  providers: [
    {
      provide: SessionBufferService,
      useFactory: async () => {
        const svc = new SessionBufferService();
        await svc.init();
        return svc;
      },
    },
  ],
  exports: [SessionBufferService],
})
export class SessionBufferModule implements OnModuleInit {
  async onModuleInit(): Promise<void> {}
}
