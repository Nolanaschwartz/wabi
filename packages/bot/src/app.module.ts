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
import { WelcomeModule } from './modules/welcome/welcome.module';
import { HelpModule } from './modules/help/help.module';
import { UserModule } from './modules/user/user.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Local dev runs each package from its own dir (cwd = packages/bot), where there is no
      // .env. Fall back to the repo-root .env so the bot finds DISCORD_TOKEN, DATABASE_URL,
      // DISCORD_HUB_GUILD_ID, etc. A packages/bot/.env (first) still wins if one is ever added.
      // In Docker/Railway these files are absent and config comes from injected process.env.
      envFilePath: ['.env', '../../.env'],
    }),
    NecordModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        token: config.getOrThrow('DISCORD_TOKEN'),
        // GuildMembers is a PRIVILEGED intent (like MessageContent) — it must be enabled in the
        // Discord developer portal and is subject to Discord approval at 100+ servers. It is
        // required for the guildMemberAdd welcome DM on hub join (ADR-0015 Task 23).
        intents: ['Guilds', 'GuildMembers', 'DirectMessages', 'MessageContent'],
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
    WelcomeModule,
    HelpModule,
    UserModule,
  ],
})
export class AppModule {}
