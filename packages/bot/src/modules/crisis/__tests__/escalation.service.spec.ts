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
    user: { findUnique: jest.fn().mockResolvedValue({ locale: 'en-US' }) },
    escalationEvent: { create: jest.fn().mockResolvedValue({}) },
  },
}));

describe('EscalationService', () => {
  let service: EscalationService;
  let crisisResources: { resourcesFor: jest.Mock };
  let crisisAftermath: { onEscalation: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    crisisResources = {
      resourcesFor: jest.fn().mockReturnValue({
        resources: [{ type: 'phone', name: '988 Lifeline', phone: '988' }],
      }),
    };
    crisisAftermath = { onEscalation: jest.fn().mockResolvedValue(undefined) };
    service = new EscalationService(
      crisisResources as any,
      crisisAftermath as any,
    );
  });

  it('returns the locale crisis resources as a renderable payload — no transport', async () => {
    const response = await service.escalate('123', 'tripwire');

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
    await service.escalate('123', 'tripwire');

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { discordId: '123' },
    });
  });

  it('records exactly ONE Escalation Event, tagged with the layer that fired', async () => {
    await service.escalate('123', 'classifier');

    expect(prisma.escalationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.escalationEvent.create).toHaveBeenCalledWith({
      data: { userId: '123', layer: 'classifier' },
    });
  });

  it('hands off to the Crisis Aftermath by default (DM-surfaced crisis)', async () => {
    await service.escalate('123', 'tripwire');

    expect(crisisAftermath.onEscalation).toHaveBeenCalledTimes(1);
    expect(crisisAftermath.onEscalation).toHaveBeenCalledWith('123');
  });

  it('skips the DM-session Aftermath when startAftermath is false (a logged field is not a Conversation)', async () => {
    const response = await service.escalate('123', 'classifier', {
      startAftermath: false,
    });

    // Resources + event still happen — only the DM-session aftermath is withheld.
    expect(response.embeds.length).toBeGreaterThan(0);
    expect(prisma.escalationEvent.create).toHaveBeenCalledTimes(1);
    expect(crisisAftermath.onEscalation).not.toHaveBeenCalled();
  });

  it('passes the tripwire layer through unchanged', async () => {
    await service.escalate('123', 'tripwire');

    expect(prisma.escalationEvent.create).toHaveBeenCalledWith({
      data: { userId: '123', layer: 'tripwire' },
    });
  });
});
