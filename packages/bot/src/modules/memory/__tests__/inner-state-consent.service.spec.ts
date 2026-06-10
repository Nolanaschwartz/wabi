import { InnerStateConsentService } from '../inner-state-consent.service';
import { prisma } from '@wabi/shared';
import { UserService } from '../../user/user.service';

jest.mock('@wabi/shared', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('../../user/user.service', () => ({
  UserService: jest.fn().mockImplementation(() => ({
    findByDiscordId: jest.fn(),
  })),
}));

const userServiceMock = { findByDiscordId: jest.fn() };
const update = prisma.user.update as jest.Mock;

describe('InnerStateConsentService', () => {
  let service: InnerStateConsentService;
  let userService: jest.Mocked<UserService>;

  beforeEach(() => {
    jest.clearAllMocks();
    update.mockResolvedValue({});
    userService = userServiceMock as any;
    service = new InnerStateConsentService(userService);
  });

  describe('prepareFirstUsePrompt — ask once', () => {
    it('returns a prompt and marks the person asked when unconsented and never prompted', async () => {
      (userService.findByDiscordId as jest.Mock).mockResolvedValue({
        innerStateMemoryEnabled: false,
        innerStateMemoryPromptedAt: null,
      });

      const prompt = await service.prepareFirstUsePrompt('123');

      expect(prompt).not.toBeNull();
      expect(prompt!.components.length).toBeGreaterThan(0);
      // Marks asked so the next free-text log across any field does not re-prompt.
      expect(update).toHaveBeenCalledWith({
        where: { discordId: '123' },
        data: { innerStateMemoryPromptedAt: expect.any(Date) },
      });
      // Marking asked must NOT silently opt them in.
      expect(update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ innerStateMemoryEnabled: true }) }),
      );
    });

    it('returns null and does not re-mark when already prompted (at most once)', async () => {
      (userService.findByDiscordId as jest.Mock).mockResolvedValue({
        innerStateMemoryEnabled: false,
        innerStateMemoryPromptedAt: new Date('2026-06-01T00:00:00Z'),
      });

      const prompt = await service.prepareFirstUsePrompt('123');

      expect(prompt).toBeNull();
      expect(update).not.toHaveBeenCalled();
    });

    it('returns null when the person has already consented', async () => {
      (userService.findByDiscordId as jest.Mock).mockResolvedValue({
        innerStateMemoryEnabled: true,
        innerStateMemoryPromptedAt: null,
      });

      const prompt = await service.prepareFirstUsePrompt('123');

      expect(prompt).toBeNull();
      expect(update).not.toHaveBeenCalled();
    });

    it('returns null when there is no User record (DM path never creates one)', async () => {
      (userService.findByDiscordId as jest.Mock).mockResolvedValue(null);

      const prompt = await service.prepareFirstUsePrompt('123');

      expect(prompt).toBeNull();
      expect(update).not.toHaveBeenCalled();
    });

    it('first-use copy states the four required points', async () => {
      (userService.findByDiscordId as jest.Mock).mockResolvedValue({
        innerStateMemoryEnabled: false,
        innerStateMemoryPromptedAt: null,
      });

      const prompt = await service.prepareFirstUsePrompt('123');
      const copy = prompt!.content.toLowerCase();

      // 1. context use across the three inner-state fields
      expect(copy).toContain('journal');
      expect(copy).toContain('mood');
      expect(copy).toContain('tilt');
      // 2. can be turned off anytime (via /memory)
      expect(copy).toContain('/memory');
      // 3. deletion via the existing data-rights flow
      expect(copy).toContain('/data delete');
      // 4. off stops future remembering but is not retroactive
      expect(copy).toMatch(/stop|future|new/);
      expect(copy).toMatch(/erase|remove|delete/);
    });
  });

  describe('button outcomes', () => {
    it('grant opts in and records the answer', async () => {
      await service.grant('123');
      expect(update).toHaveBeenCalledWith({
        where: { discordId: '123' },
        data: { innerStateMemoryEnabled: true, innerStateMemoryPromptedAt: expect.any(Date) },
      });
    });

    it('decline leaves the flag off and records the answer', async () => {
      await service.decline('123');
      const arg = update.mock.calls[0][0];
      expect(arg.where).toEqual({ discordId: '123' });
      expect(arg.data.innerStateMemoryPromptedAt).toEqual(expect.any(Date));
      expect(arg.data.innerStateMemoryEnabled).not.toBe(true);
    });
  });

  describe('/memory toggle', () => {
    it('turns memory on when it was off', async () => {
      (userService.findByDiscordId as jest.Mock).mockResolvedValue({ innerStateMemoryEnabled: false });
      const next = await service.toggle('123');
      expect(next).toBe(true);
      expect(update).toHaveBeenCalledWith({
        where: { discordId: '123' },
        data: { innerStateMemoryEnabled: true, innerStateMemoryPromptedAt: expect.any(Date) },
      });
    });

    it('turns memory off when it was on', async () => {
      (userService.findByDiscordId as jest.Mock).mockResolvedValue({ innerStateMemoryEnabled: true });
      const next = await service.toggle('123');
      expect(next).toBe(false);
      expect(update).toHaveBeenCalledWith({
        where: { discordId: '123' },
        data: { innerStateMemoryEnabled: false, innerStateMemoryPromptedAt: expect.any(Date) },
      });
    });

    it('isEnabled reflects the stored flag', async () => {
      (userService.findByDiscordId as jest.Mock).mockResolvedValue({ innerStateMemoryEnabled: true });
      expect(await service.isEnabled('123')).toBe(true);
      (userService.findByDiscordId as jest.Mock).mockResolvedValue({ innerStateMemoryEnabled: false });
      expect(await service.isEnabled('123')).toBe(false);
      (userService.findByDiscordId as jest.Mock).mockResolvedValue(null);
      expect(await service.isEnabled('123')).toBe(false);
    });

    it('buildStatus renders a single toggle button reflecting current state', () => {
      const off = service.buildStatus(false);
      const on = service.buildStatus(true);
      expect(off.components.length).toBe(1);
      expect(on.components.length).toBe(1);
      expect(off.content.toLowerCase()).toMatch(/off/);
      expect(on.content.toLowerCase()).toMatch(/on/);
    });
  });
});
