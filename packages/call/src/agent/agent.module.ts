import { Module } from '@nestjs/common';
import { LivekitModule } from '../livekit/livekit.module';
import { VoiceAgentService } from './voice-agent.service';
import { VoiceMemoryService } from './voice-memory.service';

@Module({
  imports: [LivekitModule],
  providers: [VoiceAgentService, VoiceMemoryService],
  exports: [VoiceAgentService, VoiceMemoryService],
})
export class AgentModule {}
