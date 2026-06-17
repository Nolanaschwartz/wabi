import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Arm Nest lifecycle hooks so OnModuleInit/OnApplicationShutdown fire on SIGTERM/SIGINT
  // (redeploys). Mirrors the bot; later slices rely on shutdown to drain pg-boss cleanly.
  app.enableShutdownHooks();
  const port = process.env.RESEARCH_PORT || 3002;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ msg: 'Research worker started', port: String(port) }));
}

bootstrap();
