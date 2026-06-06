import { Injectable } from '@nestjs/common';

@Injectable()
export class CrisisScreeningService {
  private readonly explicitPatterns: RegExp[] = [
    /\bI don'?t want to live\b/i,
    /\bI don'?t want to be alive\b/i,
    /\bI don'?t want to wake up\b/i,
    /\bI want to die\b/i,
    /\bI want to kill myself\b/i,
    /\bsuicid/i,
    /\bending it all\b/i,
    /\bno reason to live\b/i,
    /\bI'?m better off dead\b/i,
    /\bI'?m going to hurt myself\b/i,
    /\bI'?m going to kill myself\b/i,
    /\bsay goodbye\b/i,
    /\bI can'?t go on\b/i,
    /\bthere'?s no point\b/i,
    /\bI want to end this\b/i,
    /\bI'?m going to end it\b/i,
    /\bI wish I were dead\b/i,
    /\bI want to go to sleep and never wake up\b/i,
    /\bI can'?t do this anymore\b/i,
    /\bI'?m so tired of living\b/i,
    /\bI'?m going to jump\b/i,
    /\bI have a plan to kill myself\b/i,
    /\bI want to overdose\b/i,
    /\bI want to slit my wrists\b/i,
    /\bI'?m going to hang myself\b/i,
  ];

  tripwire(text: string): boolean {
    const lowerText = text.toLowerCase();
    for (const pattern of this.explicitPatterns) {
      if (pattern.test(lowerText)) {
        return true;
      }
    }
    return false;
  }
}
