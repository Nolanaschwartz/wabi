import { EscalationService } from '../escalation.service';
import { prisma } from '@wabi/shared';

// EscalationService statically imports CrisisAftermathService, which pulls in pg-boss at module
// load. We inject a plain mock aftermath, so stub the transitive dep to keep the import graph clean.
jest.mock('pg-boss', () => ({
  PgBoss: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    createQueue: jest.fn(),
    work: jest.fn(),
    schedule: jest.fn(),
    stop: jest.fn(),
  })),
}));

jest.mock('@wabi/shared', () => ({
  prisma: {
    escalationEvent: { create: jest.fn().mockResolvedValue({}) },
  },
}));

describe('EscalationService', () => {
  let service: EscalationService;
  let userService: { findByDiscordId: jest.Mock };
  let crisisResources: { resourcesFor: jest.Mock };
  let crisisAftermath: { onEscalation: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    userService = {
      findByDiscordId: jest.fn().mockResolvedValue({ locale: 'en-US' }),
    };
    crisisResources = {
      resourcesFor: jest.fn().mockReturnValue({
        resources: [{ type: 'phone', name: '988 Lifeline', phone: '988' }],
      }),
    };
    crisisAftermath = { onEscalation: jest.fn().mockResolvedValue(undefined) };
    service = new EscalationService(
      userService as any,
      crisisResources as any,
      crisisAftermath as any,
    );
  });

  it('returns the locale crisis resources as a renderable payload — no transport', async () => {
    const response = await service.escalate('123', 'tripwire', 'conversation');

    expect(crisisResources.resourcesFor).toHaveBeenCalledWith('en-US');
    expect(response).toEqual(
      expect.objectContaining({
        embeds: expect.arrayContaining([
          expect.objectContaining({ title: '🚨 You matter' }),
        ]),
      }),
    );
  });

  it('resolves the locale from the userId, not a Message', async () => {
    await service.escalate('123', 'tripwire', 'conversation');

    expect(userService.findByDiscordId).toHaveBeenCalledWith('123');
  });

  it('records exactly ONE Escalation Event, tagged with the layer that fired', async () => {
    await service.escalate('123', 'classifier', 'conversation');

    expect(prisma.escalationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.escalationEvent.create).toHaveBeenCalledWith({
      data: { userId: '123', layer: 'classifier' },
    });
  });

  it('opens the Crisis Aftermath for a conversation surface (a live DM turn)', async () => {
    await service.escalate('123', 'tripwire', 'conversation');

    expect(crisisAftermath.onEscalation).toHaveBeenCalledTimes(1);
    expect(crisisAftermath.onEscalation).toHaveBeenCalledWith('123');
  });

  it('skips the DM-session Aftermath for a field surface (a logged field is not a Conversation)', async () => {
    const response = await service.escalate('123', 'classifier', 'field');

    // Resources + event still happen — only the DM-session aftermath is withheld.
    expect(response.embeds.length).toBeGreaterThan(0);
    expect(prisma.escalationEvent.create).toHaveBeenCalledTimes(1);
    expect(crisisAftermath.onEscalation).not.toHaveBeenCalled();
  });

  it('passes the tripwire layer through unchanged', async () => {
    await service.escalate('123', 'tripwire', 'conversation');

    expect(prisma.escalationEvent.create).toHaveBeenCalledWith({
      data: { userId: '123', layer: 'tripwire' },
    });
  });
});
