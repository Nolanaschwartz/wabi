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
    expect(xp.award).toHaveBeenCalledWith('123', 10, 'coaching');
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

    expect(xp.award).toHaveBeenCalledWith('123', 10, 'journal');
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
      expect(streaks.getCurrentStreak).toHaveBeenCalledWith('123');
      expect(streaks.wellnessScore).toHaveBeenCalledWith('123');
      expect(profile).toEqual({
        xp: 120,
        streak: 5,
        wellnessScore: 80,
        wellnessLevel: '🌟 Wellness Champion',
      });
    });
  });
});
