import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { LivekitModule } from './livekit/livekit.module';
import { DiscordModule } from './discord/discord.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // The worker runs from its own dir (cwd = packages/call) where there is no .env; fall back to
      // the repo-root .env (canonical app config the bot reads). process.env is populated here at
      // bootstrap, so the lazy-config rule holds — read env per call, never cache it in a field.
      envFilePath: ['.env', '../../.env'],
    }),
    LivekitModule,
    DiscordModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
