import { Module } from '@nestjs/common';
import { VoiceAgentService } from './voice-agent.service';
import { VoiceMemoryService } from './voice-memory.service';

@Module({
  providers: [VoiceAgentService, VoiceMemoryService],
  exports: [VoiceAgentService, VoiceMemoryService],
})
export class AgentModule {}
