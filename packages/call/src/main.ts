import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule); // ConfigModule loads the root .env
  app.enableCors(); // LAN clients hit this from other origins
  app.enableShutdownHooks(); // fire lifecycle hooks on SIGTERM/SIGINT (redeploys); mirrors bot/research
  const port = process.env.CALL_PORT || 3003;
  await app.listen(port, '0.0.0.0'); // bind all interfaces so the LAN can reach it
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ msg: 'Voice call agent started', port: String(port) }));
}
bootstrap();
