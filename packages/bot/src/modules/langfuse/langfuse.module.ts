import { Module } from '@nestjs/common';
import { LangfuseTracer } from './langfuse-tracer.service';
import { OtelTracingService } from './otel-tracing.service';

@Module({
  providers: [
    {
      provide: LangfuseTracer,
      useValue: new LangfuseTracer(),
    },
    // Eagerly instantiated so its constructor builds the isolated OTEL provider at bootstrap (after
    // ConfigModule), making startActiveObservation available before the first DM turn arrives.
    OtelTracingService,
  ],
  exports: [LangfuseTracer, OtelTracingService],
})
export class LangfuseModule {}
