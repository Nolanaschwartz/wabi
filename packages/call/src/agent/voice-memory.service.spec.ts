// Mock the I/O the service composes; the privacy gate itself is covered by memory-context.spec.ts.
jest.mock('@wabi/shared', () => ({
  prisma: { user: { findUnique: jest.fn() } },
}));
jest.mock('./mem0', () => ({ recall: jest.fn() }));

import { prisma } from '@wabi/shared';
import { recall } from './mem0';
import { VoiceMemoryService } from './voice-memory.service';

const findUnique = prisma.user.findUnique as jest.Mock;
const recallMock = recall as jest.Mock;

// Minimal stand-in for a discord.js VoiceBasedChannel: only `.members.map` is used.
const channelOf = (members: Array<{ id: string; bot: boolean }>) =>
  ({
    members: {
      map: <T>(fn: (m: { id: string; user: { bot: boolean } }) => T) =>
        members.map((m) => fn({ id: m.id, user: { bot: m.bot } })),
    },
  }) as any;

describe('VoiceMemoryService.contextFor', () => {
  beforeEach(() => jest.clearAllMocks());

  it('maps members and returns the lone human’s recalled facts', async () => {
    findUnique.mockResolvedValue({ id: 'u1' });
    recallMock.mockResolvedValue(['plays Apex']);
    const block = await new VoiceMemoryService().contextFor(
      channelOf([
        { id: 'd1', bot: false },
        { id: 'bot-1', bot: true },
      ]),
    );
    expect(findUnique).toHaveBeenCalledWith({ where: { discordId: 'd1' } });
    expect(block).toContain('plays Apex');
  });

  it('fails open to an empty block when identity lookup throws', async () => {
    findUnique.mockRejectedValue(new Error('postgres down'));
    const block = await new VoiceMemoryService().contextFor(
      channelOf([{ id: 'd1', bot: false }]),
    );
    expect(block).toBe('');
  });
});
