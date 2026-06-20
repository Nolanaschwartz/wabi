import { Injectable } from '@nestjs/common';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

@Injectable()
export class LivekitService {
  private readonly key = req('LIVEKIT_API_KEY');
  private readonly secret = req('LIVEKIT_API_SECRET');
  // RoomServiceClient talks HTTP(S); LIVEKIT_URL can be ws(s):// — SDK handles both.
  readonly rooms = new RoomServiceClient(
    req('LIVEKIT_URL'),
    this.key,
    this.secret,
  );

  // Mint a join token. Rooms auto-create on first join, so no create step needed.
  async createToken(identity: string, room: string): Promise<string> {
    const at = new AccessToken(this.key, this.secret, { identity });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
    return at.toJwt();
  }
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}
