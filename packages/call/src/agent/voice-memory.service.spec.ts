// Mock the I/O the service composes; the privacy gate itself is covered by memory-context.spec.ts.
jest.mock('@wabi/shared', () => ({
  prisma: { user: { findUnique: jest.fn() } },
  recall: jest.fn(),
}));

import { prisma, recall } from '@wabi/shared';
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

  // Regression: the coaching bot keys mem0 by DISCORD id (session-sweeper writes mem0_<discordId>), so
  // voice must recall by the Discord id too — NOT the wabi User.id. Keying by User.id reads an empty
  // partition and the assistant forgets everything the coach learned.
  it('recalls by the Discord id (the bot’s mem0 partition), not the wabi User.id', async () => {
    findUnique.mockResolvedValue({ id: 'u1' }); // a User exists, but its uuid must NOT be the recall key
    recallMock.mockResolvedValue([]);
    await new VoiceMemoryService().contextFor(channelOf([{ id: 'd1', bot: false }]));
    expect(recallMock).toHaveBeenCalledWith('d1');
  });

  it('fails open to an empty block when identity lookup throws', async () => {
    findUnique.mockRejectedValue(new Error('postgres down'));
    const block = await new VoiceMemoryService().contextFor(
      channelOf([{ id: 'd1', bot: false }]),
    );
    expect(block).toBe('');
  });
});
