import { ProfileController } from '../profile.controller';
import { HabitEngagementService } from '../habit-engagement.service';
import { AccessResolver } from '../../billing/access-resolver';

jest.mock('../habit-engagement.service', () => ({
  HabitEngagementService: jest.fn().mockImplementation(() => ({ profile: jest.fn() })),
}));

jest.mock('../../billing/access-resolver', () => ({
  AccessResolver: jest.fn().mockImplementation(() => ({ resolveAccount: jest.fn() })),
}));

function fakeInteraction() {
  return {
    user: { id: '123', username: 'tester' },
    deferReply: jest.fn().mockResolvedValue(undefined),
    editReply: jest.fn().mockResolvedValue(undefined),
  } as any;
}

describe('ProfileController — /profile reads the Engagement model in the person\'s timezone', () => {
  let controller: ProfileController;
  let engagement: jest.Mocked<HabitEngagementService>;
  let access: jest.Mocked<AccessResolver>;

  beforeEach(() => {
    jest.clearAllMocks();
    engagement = new HabitEngagementService(undefined as any, undefined as any) as any;
    access = new AccessResolver(undefined as any) as any;
    controller = new ProfileController(engagement, access);
  });

  // The /profile surface must show the SAME streak the coaching reply shows. Coaching resolves the
  // person's timezone via AccessResolver.resolveAccount; /profile must use the same source and pass it
  // into profile, so both surfaces bucket day boundaries identically (not on the server's UTC clock).
  it('resolves the person\'s timezone (same source as coaching) and threads it into profile', async () => {
    (access.resolveAccount as jest.Mock).mockResolvedValue({
      access: {} as any,
      consented: true,
      timezone: 'America/Los_Angeles',
    });
    (engagement.profile as jest.Mock).mockResolvedValue({
      xp: 50,
      streak: 4,
      wellnessScore: 30,
      wellnessLevel: '💪 Wellness Beginner',
    });
    const interaction = fakeInteraction();

    await controller.execute([interaction] as any);

    expect(access.resolveAccount).toHaveBeenCalledWith('123');
    expect(engagement.profile).toHaveBeenCalledWith('123', 'America/Los_Angeles');
  });

  it('falls back to UTC when the person has no timezone set', async () => {
    (access.resolveAccount as jest.Mock).mockResolvedValue({
      access: {} as any,
      consented: true,
      timezone: 'UTC',
    });
    (engagement.profile as jest.Mock).mockResolvedValue({
      xp: 0,
      streak: 0,
      wellnessScore: 0,
      wellnessLevel: '💪 Wellness Beginner',
    });
    const interaction = fakeInteraction();

    await controller.execute([interaction] as any);

    expect(engagement.profile).toHaveBeenCalledWith('123', 'UTC');
  });
});
