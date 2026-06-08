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
  let message: any;

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
    message = {
      author: { id: '123' },
      reply: jest.fn().mockResolvedValue({}),
    };
  });

  it('surfaces locale crisis resources to the person', async () => {
    await service.escalate(message, 'tripwire');

    expect(crisisResources.resourcesFor).toHaveBeenCalledWith('en-US');
    expect(message.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.arrayContaining([
          expect.objectContaining({ title: '🚨 You matter' }),
        ]),
      }),
    );
  });

  it('records exactly ONE Escalation Event, tagged with the layer that fired', async () => {
    await service.escalate(message, 'classifier');

    expect(prisma.escalationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.escalationEvent.create).toHaveBeenCalledWith({
      data: { userId: '123', layer: 'classifier' },
    });
  });

  it('hands off to the Crisis Aftermath exactly once (one quarantine + one follow-up)', async () => {
    await service.escalate(message, 'tripwire');

    expect(crisisAftermath.onEscalation).toHaveBeenCalledTimes(1);
    expect(crisisAftermath.onEscalation).toHaveBeenCalledWith('123');
  });

  it('passes the tripwire layer through unchanged', async () => {
    await service.escalate(message, 'tripwire');

    expect(prisma.escalationEvent.create).toHaveBeenCalledWith({
      data: { userId: '123', layer: 'tripwire' },
    });
  });
});
