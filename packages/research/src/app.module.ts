import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ResearchModule } from './research.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // The worker runs from its own dir (cwd = packages/research) where there is no .env; fall
      // back to the repo-root .env (canonical app config). This REPLACES the hand-rolled
      // loadDotenv() for the Nest path. process.env is populated here at bootstrap, so the
      // lazy-getter rule holds (getProvider re-reads it per call — never cache env in a field).
      envFilePath: ['.env', '../../.env'],
    }),
    ResearchModule,
  ],
})
export class AppModule {}
