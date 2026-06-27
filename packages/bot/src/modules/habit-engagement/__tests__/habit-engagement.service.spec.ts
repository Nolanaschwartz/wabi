import { HabitEngagementService } from '../habit-engagement.service';
import { XpService } from '../../xp/xp.service';
import { StreaksService } from '../../streaks/streaks.service';

jest.mock('../../xp/xp.service', () => ({
  XpService: jest.fn().mockImplementation(() => ({ award: jest.fn(), total: jest.fn() })),
}));

jest.mock('../../streaks/streaks.service', () => ({
  StreaksService: jest.fn().mockImplementation(() => ({
    advance: jest.fn(),
    getCurrentStreak: jest.fn(),
    wellnessScore: jest.fn(),
  })),
}));

jest.mock('../../user/user.service', () => ({
  UserService: jest.fn().mockImplementation(() => ({
    findByDiscordId: jest.fn(),
  })),
}));

describe('HabitEngagementService — the single Engagement writer (ADR-0027)', () => {
  let service: HabitEngagementService;
  let xp: jest.Mocked<XpService>;
  let streaks: jest.Mocked<StreaksService>;

  beforeEach(() => {
    jest.clearAllMocks();
    xp = new XpService() as any;
    streaks = new StreaksService() as any;
    service = new HabitEngagementService(xp, streaks);
  });

  it('on a new engagement day, advances the streak then logs the Engagement (awards its XP)', async () => {
    (streaks.advance as jest.Mock).mockResolvedValue({
      streak: 3,
      message: 'continues',
      isNewDay: true,
    });

    const result = await service.record('123', 'coaching', 'UTC');

    expect(streaks.advance).toHaveBeenCalledWith('123', 'UTC');
    expect(xp.award).toHaveBeenCalledWith('123', 10, 'coaching', expect.any(String));
    expect(result).toEqual({ streak: 3, message: 'continues', xpAwarded: 10 });
  });

  it('does not award or log a second Engagement the same day (no inflation)', async () => {
    (streaks.advance as jest.Mock).mockResolvedValue({
      streak: 3,
      message: '',
      isNewDay: false,
    });

    const result = await service.record('123', 'journal');

    expect(xp.award).not.toHaveBeenCalled();
    expect(result).toEqual({ streak: 3, message: '', xpAwarded: 0 });
  });

  it('carries each habit\'s XP from the table', async () => {
    (streaks.advance as jest.Mock).mockResolvedValue({
      streak: 1,
      message: 'Welcome',
      isNewDay: true,
    });

    await service.record('123', 'journal');

    expect(xp.award).toHaveBeenCalledWith('123', 10, 'journal', expect.any(String));
  });

  // Race backstop (ADR-0027): the (userId, engagedDay) unique index on XpEntry guarantees one
  // Engagement row per engaged day even when two events (journal + coaching) arrive in the same
  // instant and both pass the racy app-level isNewDay check. The second insert is rejected with a
  // Prisma unique-constraint violation (P2002), which record must treat as "already engaged today".
  it('treats a unique-constraint violation (P2002) on award as already-engaged: no second award, no throw', async () => {
    (streaks.advance as jest.Mock).mockResolvedValue({
      streak: 4,
      message: 'continues',
      isNewDay: true,
    });
    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    (xp.award as jest.Mock).mockRejectedValue(p2002);

    const result = await service.record('123', 'coaching', 'UTC');

    expect(xp.award).toHaveBeenCalledWith('123', 10, 'coaching', expect.any(String));
    expect(result).toEqual({ streak: 4, message: 'continues', xpAwarded: 0 });
  });

  it('re-throws non-unique award errors — only P2002 is benign', async () => {
    (streaks.advance as jest.Mock).mockResolvedValue({
      streak: 1,
      message: 'Welcome',
      isNewDay: true,
    });
    (xp.award as jest.Mock).mockRejectedValue(
      Object.assign(new Error('db down'), { code: 'P1001' }),
    );

    await expect(service.record('123', 'journal')).rejects.toThrow('db down');
  });

  // The Engagement read seam (ADR-0027). Engagement is the single unit behind streak/XP/wellness, so
  // the cross-cutting profile read lives HERE — the one place that already holds both the XP and streak
  // collaborators — not reached upward from inside StreaksService.
  describe('profile (the Engagement read model)', () => {
    it('aggregates total XP, current streak, and wellness from the collaborators', async () => {
      (xp.total as jest.Mock).mockResolvedValue(120);
      (streaks.getCurrentStreak as jest.Mock).mockResolvedValue(5);
      (streaks.wellnessScore as jest.Mock).mockResolvedValue({ score: 80, level: '🌟 Wellness Champion' });

      const profile = await service.profile('123');

      expect(xp.total).toHaveBeenCalledWith('123');
      expect(streaks.getCurrentStreak).toHaveBeenCalledWith('123', 'UTC');
      expect(streaks.wellnessScore).toHaveBeenCalledWith('123', 'UTC');
      expect(profile).toEqual({
        xp: 120,
        streak: 5,
        wellnessScore: 80,
        wellnessLevel: '🌟 Wellness Champion',
      });
    });

    // Timezone consistency: the streak/wellness reads must bucket day boundaries in the PERSON's
    // timezone — the same tz the coaching path threads into advance — so /profile shows the same
    // number the coaching reply does. The hardcoded 'UTC' was the bug.
    it('threads the person\'s timezone (not UTC) into the streak and wellness reads', async () => {
      (xp.total as jest.Mock).mockResolvedValue(0);
      (streaks.getCurrentStreak as jest.Mock).mockResolvedValue(3);
      (streaks.wellnessScore as jest.Mock).mockResolvedValue({ score: 10, level: '💪 Wellness Beginner' });

      await service.profile('123', 'America/Los_Angeles');

      expect(streaks.getCurrentStreak).toHaveBeenCalledWith('123', 'America/Los_Angeles');
      expect(streaks.wellnessScore).toHaveBeenCalledWith('123', 'America/Los_Angeles');
    });
  });
});
