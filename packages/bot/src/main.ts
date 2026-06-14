import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { initSentry } from './lib/sentry';
import { JsonLogger } from './lib/json-logger';

initSentry(process.env.SENTRY_DSN || 'http://localhost:8000/1');

async function bootstrap() {
  const logger = new JsonLogger('Bootstrap');
  const app = await NestFactory.create(AppModule, { logger });
  // Arm NestJS lifecycle hooks so OnApplicationShutdown fires on SIGTERM/SIGINT (redeploys). Without
  // this the LangfuseTracer flush never runs and the last turns' ingestion is orphaned on every exit.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT || 3000);
  logger.log('Server started', { port: process.env.PORT || '3000' });
}

bootstrap();
