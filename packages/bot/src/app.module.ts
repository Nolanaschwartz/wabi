import { Module } from '@nestjs/common';
import { NecordModule } from 'necord';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Partials } from 'discord.js';
import { EchoModule } from './modules/echo/echo.module';
import { HealthModule } from './modules/health/health.module';
import { BillingModule } from './modules/billing/billing.module';
import { CoachingModule } from './modules/coaching/coaching.module';
import { CrisisModule } from './modules/crisis/crisis.module';
import { MemoryModule } from './modules/memory/memory.module';
import { MoodModule } from './modules/mood/mood.module';
import { PlaytimeModule } from './modules/playtime/playtime.module';
import { JournalModule } from './modules/journal/journal.module';
import { CrisisAftermathModule } from './modules/crisis-aftermath/crisis-aftermath.module';
import { TiltModule } from './modules/tilt/tilt.module';
import { StreaksModule } from './modules/streaks/streaks.module';
import { CheckInModule } from './modules/checkins/checkin.module';
import { DataRightsModule } from './modules/data-rights/data-rights.module';
import { StrategyAdminModule } from './modules/strategy-admin/strategy-admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    NecordModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        token: config.getOrThrow('DISCORD_TOKEN'),
        intents: ['Guilds', 'DirectMessages', 'MessageContent'],
        partials: [Partials.Channel],
      }),
      inject: [ConfigService],
    }),
    EchoModule,
    HealthModule,
    BillingModule,
    CoachingModule,
    CrisisModule,
    MemoryModule,
    MoodModule,
    PlaytimeModule,
    JournalModule,
    CrisisAftermathModule,
    TiltModule,
    StreaksModule,
    CheckInModule,
    DataRightsModule,
    StrategyAdminModule,
  ],
})
export class AppModule {}
