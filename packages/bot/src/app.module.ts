import { Module } from '@nestjs/common';
import { NecordModule } from 'necord';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Partials } from 'discord.js';
import { EchoModule } from './modules/echo/echo.module';

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
  ],
})
export class AppModule {}
