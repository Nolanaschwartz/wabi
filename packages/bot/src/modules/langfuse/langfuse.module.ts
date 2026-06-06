import { Module } from '@nestjs/common';
import { LangfuseTracer } from './langfuse-tracer.service';

@Module({
  providers: [
    {
      provide: LangfuseTracer,
      useValue: new LangfuseTracer(),
    },
  ],
  exports: [LangfuseTracer],
})
export class LangfuseModule {}
