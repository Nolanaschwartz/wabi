import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { LivekitService } from './livekit.service';

@Controller('livekit')
export class LivekitController {
  constructor(private readonly livekit: LivekitService) {}

  @Post('token')
  async token(@Body() body: { identity?: string; room?: string }) {
    const { identity, room } = body;
    if (!identity || !room)
      throw new BadRequestException('identity and room are required');
    return {
      token: await this.livekit.createToken(identity, room),
      url: process.env.LIVEKIT_URL,
    };
  }
}
