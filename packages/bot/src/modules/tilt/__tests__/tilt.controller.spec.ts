jest.mock('necord', () => ({
  Context: () => () => {},
  Options: () => () => {},
  IntegerOption: () => () => {},
  StringOption: () => () => {},
  Subcommand: () => () => {},
  createCommandGroupDecorator: () => () => () => {},
}));
jest.mock('@wabi/shared', () => ({ prisma: {} }));
// TiltService transitively imports scheduler/strategy-retrieval; stub it. We inject a plain mock.
jest.mock('../tilt.service', () => ({ TiltService: class {} }));
// Stub the logger module so its discord.js + crisis/memory imports never load; we inject a mock.
jest.mock('../../inner-state-logger/inner-state-logger.service', () => ({
  InnerStateLoggerService: class {},
}));

import { MessageFlags } from 'discord.js';
import { TiltController } from '../tilt.controller';
import { TiltService } from '../tilt.service';
import { InnerStateLoggerService } from '../../inner-state-logger/inner-state-logger.service';

function mockInteraction() {
  return {
    deferReply: jest.fn().mockResolvedValue({}),
    editReply: jest.fn().mockResolvedValue({}),
    user: { id: 'user_1' },
  } as any;
}

describe('TiltController', () => {
  let controller: TiltController;
  let tiltService: jest.Mocked<TiltService>;
  let logger: jest.Mocked<InnerStateLoggerService>;

  beforeEach(() => {
    tiltService = {
      acceptOffer: jest.fn().mockResolvedValue('Take a breath.'),
      resolve: jest.fn().mockResolvedValue(undefined),
      stats: jest.fn().mockResolvedValue({ total: 0, avgSeverity: 0, commonTriggers: [] }),
    } as any;
    logger = { log: jest.fn().mockResolvedValue({ kind: 'logged' }) } as any;
    controller = new TiltController(tiltService, logger);
  });

  describe('/tilt start — routes through the inner-state logger', () => {
    it('passes the raw trigger as the screened free text under the "Tilt trigger" prefix', async () => {
      await controller.start([mockInteraction()], { trigger: 'lost ranked again', severity: 7 });

      const write = logger.log.mock.calls[0][0];
      expect(write.freeText).toEqual({ value: 'lost ranked again', derivePrefix: 'Tilt trigger' });
    });

    it('persist starts a session with the trigger + clamped severity and returns the technique', async () => {
      await controller.start([mockInteraction()], { trigger: 'lost ranked again', severity: 99 });

      const write = logger.log.mock.calls[0][0];
      // persist now receives the Screened proof; tilt's writer ignores it (its trigger is a bounded
      // stored value, not the minable arm — see ADR-0031 scope), so any proof shape is fine here.
      const technique = await write.persist({ freeText: 'lost ranked again', derivePrefix: 'Tilt trigger' } as any);

      expect(tiltService.acceptOffer).toHaveBeenCalledWith('user_1', {
        trigger: 'lost ranked again',
        severity: 10,
      });
      expect(technique).toBe('Take a breath.');
    });

    it('confirm renders the standalone "Tilt session started" copy', async () => {
      await controller.start([mockInteraction()], { trigger: 'lost ranked again', severity: 7 });

      const write = logger.log.mock.calls[0][0];
      const text = write.confirm('Take a breath.');
      expect(text).toContain('Tilt session started');
      expect(text).toContain('lost ranked again');
      expect(text).toContain('Severity: 7/10');
      expect(text).toContain('Take a breath.');
    });

    it('a severity-only start carries no free text and persists with an "unknown" trigger', async () => {
      await controller.start([mockInteraction()], { severity: 8 });

      const write = logger.log.mock.calls[0][0];
      // The bundle is still present (prefix can't desync from value), but value is blank, so the
      // logger treats it as structured-only — no screen, no derive, no prompt.
      expect(write.freeText).toEqual({ value: undefined, derivePrefix: 'Tilt trigger' });

      await write.persist({ freeText: null, derivePrefix: null } as any);
      expect(tiltService.acceptOffer).toHaveBeenCalledWith('user_1', {
        trigger: 'unknown',
        severity: 8,
      });
    });
  });

  // resolve and stats do not write inner state, so they keep their own ephemeral defer.
  it('/tilt resolve defers ephemerally and resolves the session', async () => {
    const interaction = mockInteraction();
    await controller.resolve([interaction]);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(tiltService.resolve).toHaveBeenCalledWith('user_1');
  });

  it('/tilt stats defers ephemerally so common triggers never leak', async () => {
    const interaction = mockInteraction();
    await controller.stats([interaction]);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  });
});
