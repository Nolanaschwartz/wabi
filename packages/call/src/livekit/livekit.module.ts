import { Module } from '@nestjs/common';
import { LivekitService } from './livekit.service';

// No HTTP controller: in the Discord-bridge flow, tokens are minted server-side by the bridge and
// voice agent via LivekitService.createToken. An unauthenticated POST /livekit/token (inherited from
// the standalone LAN-client app) would mint a join token for any identity/room — removed as unused
// attack surface. Add an authenticated endpoint only if a non-Discord client ever needs tokens.
@Module({
  providers: [LivekitService],
  exports: [LivekitService],
})
export class LivekitModule {}
