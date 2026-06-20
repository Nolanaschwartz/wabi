import { Module } from '@nestjs/common';
import { LivekitModule } from '../livekit/livekit.module';
import { VoiceAgentService } from './voice-agent.service';

@Module({
  imports: [LivekitModule],
  providers: [VoiceAgentService],
  exports: [VoiceAgentService],
})
export class AgentModule {}
