import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { initSentry } from './lib/sentry';

initSentry(process.env.SENTRY_DSN || 'http://localhost:8000/1');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT || 3000);
}

bootstrap();
